import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { debug, error, info, success, warn } from "./index.js";

interface ReleaseConfig {
    path: string;
    composeFile?: string;
}

export async function handleRelease(
    config: ReleaseConfig,
    releaseTag: string,
    repo: string,
    updateDiscordStep?: (
        stepIdx: number,
        status?: string,
        errorMessage?: string,
    ) => Promise<void>,
): Promise<void> {
    const {
        path: repoPath,
        composeFile = "docker-compose.yml",
    } = config;

    let step = 0;
    if (updateDiscordStep) await updateDiscordStep(step++);

    if (!fs.existsSync(repoPath)) {
        try {
            execSync(`git clone ${repo} ${repoPath}`, { stdio: "inherit" });
        } catch (err) {
            warn("git clone failed, trying with gh CLI...");
            execSync(`gh repo clone ${repo} ${repoPath}`, {
                stdio: "inherit",
                env: {
                    ...process.env,
                },
            });
        }
    }
    if (updateDiscordStep) await updateDiscordStep(step++);

    execSync(`cd ${repoPath} && git fetch --tags`, { stdio: "inherit" });
    const previousRevision = execSync(
        `cd ${repoPath} && git rev-parse HEAD`,
    )
        .toString()
        .trim();
    const packageJsonPath = path.join(repoPath, "package.json");
    const previousTag = fs.existsSync(packageJsonPath)
        ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).gitRelease
        : undefined;

    debug("Previous revision:", previousRevision);

    if (fs.existsSync(packageJsonPath)) {
        execSync(`cd ${repoPath} && git restore package.json`);
    }
    execSync(`cd ${repoPath} && git checkout ${releaseTag}`, {
        stdio: "inherit",
    });
    if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        pkg.gitRelease = releaseTag;
        fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");
    }
    if (updateDiscordStep) await updateDiscordStep(step++);

    const composePath = path.join(repoPath, composeFile);
    const testComposeFile = composeFile.replace(/\.ya?ml$/, "-test.yml");
    const testComposePath = path.join(repoPath, testComposeFile);
    fs.copyFileSync(composePath, testComposePath);
    info(`Created test compose file: ${testComposeFile}`);
    let testContent = fs.readFileSync(testComposePath, "utf8");
    testContent = testContent.replace(
        /restart:\s*(?:"?always"?|on-failure(?::\s*\d+)?)/g,
        'restart: "no"',
    );
    fs.writeFileSync(testComposePath, testContent);
    info(`Disabled restart policies in ${testComposeFile}`);

    const waitForHealthy = (file: string) => {
        const maxWait = 60 * 1000;
        const start = Date.now();

        while (Date.now() - start < maxWait) {
            debug("Checking container health...");
            const raw = execSync(
                `docker compose -f ${file} ps --format json`,
            ).toString();

            const containers = raw
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line)) as Array<{
                    State: string;
                    Health?: string;
                }>;

            let allHealthy = true;
            containers.forEach((c, idx) => {
                debug(
                    `Container ${idx}: State=${c.State}, Health=${
                        c.Health ?? "N/A"
                    }`,
                );
                if (c.State === "exited") {
                    debug(
                        `Container ${idx} exited unexpectedly — treating as failure.`,
                    );
                    allHealthy = false;
                } else if (
                    c.State !== "running" ||
                    (c.Health && c.Health !== "healthy")
                ) {
                    allHealthy = false;
                }
            });

            if (allHealthy) {
                info("All containers are healthy.");
                return;
            }

            debug(
                "Some containers are unhealthy or have exited. Waiting 2 seconds...",
            );
            execSync(`sleep 2`);
        }

        throw new Error("Containers did not become healthy in time");
    };

    try {
        execSync(
            `cd ${repoPath} && docker compose -f ${testComposePath} up -d --build`,
            { stdio: "inherit" },
        );
        if (updateDiscordStep) await updateDiscordStep(step++);
        waitForHealthy(testComposePath);
        if (updateDiscordStep) await updateDiscordStep(step++);
        success("Test deployment succeeded for", releaseTag);

        execSync(
            `cd ${repoPath} && docker compose -f ${testComposePath} down`,
            { stdio: "inherit" },
        );
        fs.unlinkSync(testComposePath);
        info(`Removed test compose file: ${testComposeFile}`);

        execSync(
            `cd ${repoPath} && docker compose -f ${composePath} up -d --build`,
            { stdio: "inherit" },
        );
        waitForHealthy(composePath);
        success("Production deployment succeeded for", releaseTag);
    } catch (err) {
        error("Deployment failed, rolling back:", err);
        if (updateDiscordStep) {
            await updateDiscordStep(
                step - 1,
                "failed",
                err instanceof Error ? err.message : String(err),
            );
        }

        execSync(`cd ${repoPath} && docker compose -f ${composePath} down`, {
            stdio: "inherit",
        });
        if (fs.existsSync(testComposePath)) {
            execSync(
                `cd ${repoPath} && docker compose -f ${testComposePath} down`,
            );
            fs.unlinkSync(testComposePath);
            info(`Removed test compose file: ${testComposeFile}`);
        }

        if (fs.existsSync(packageJsonPath)) {
            execSync(`cd ${repoPath} && git restore package.json`, {
                stdio: "inherit",
            });
        }
        execSync(`cd ${repoPath} && git checkout ${previousRevision}`, {
            stdio: "inherit",
        });
        if (previousTag && fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
            pkg.gitRelease = previousTag;
            fs.writeFileSync(
                packageJsonPath,
                JSON.stringify(pkg, null, 2) + "\n",
            );
        }

        throw err;
    }
}
