import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fs from "fs";
import { handleRelease } from "./docker-manager.js";
import { resolve } from "path";
import chalk from "chalk";

chalk.level = 1;
export const log = console.log;
export const info = (...data: any[]) => log(chalk.cyan(data));
export const warn = (...data: any[]) => log(chalk.yellow(data));
export const error = (...data: any[]) => log(chalk.red(data));
export const success = (...data: any[]) => log(chalk.green(data));
export const debug = (...data: any[]) => log(chalk.gray(data));

export const logDiscord = async (message: string) => {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        warn("DISCORD_WEBHOOK_URL not set, skipping Discord log");
        return;
    }
    const payload = {
        content: message,
        username: "Deployments",
        avatar_url: "https://m.media-amazon.com/images/I/81wY1FqCVlL.jpg",
    };
    await fetch(webhookUrl + "?wait=true", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    }).then((res) => {
        if (!res.ok) {
            error("Failed to send Discord log:", res.statusText);
        }
    }).catch((err) => {
        error("Error sending Discord log:", err);
    });
};

export async function createDiscordStepUpdater(repo: string, tag: string) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        warn("DISCORD_WEBHOOK_URL not set, skipping Discord log");
        return async () => {};
    }

    function capitalizeFirstLetter(str: string) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }
    const steps = ["start", "pull", "build", "test", "deploy"].map(
        capitalizeFirstLetter,
    );
    let currentStep = -1;
    let messageId: string | null = null;
    let payload: any = {
        flags: 1 << 15,
        components: [
            {
                type: 17,
                accent_color: 3447003,
                spoiler: false,
                components: [
                    {
                        type: 10,
                        content: renderContent(repo, tag, steps, currentStep),
                    },
                ],
            },
        ],
    };

    function renderContent(
        repo: string,
        tag: string,
        steps: string[],
        currentStep: number,
        status?: string,
        errorMessage?: string,
    ) {
        // const lines = steps.map((s, i) => {
        //     let icon = "<:blank:1383946250839396362>";
        //     if (i < currentStep) icon = "🟩";
        //     else if (i === currentStep) icon = "🟦";
        //     return `${icon} ${s}`;
        // });
        // let statusLine = "";
        // if (status === "failed" && currentStep >= 0 && currentStep < steps.length) {
        //     statusLine = `\n❌ Failed on step: **${steps[currentStep]}**`;
        // } else if (status) {
        //     statusLine = `\n-# (${status})`;
        // }
        // return `### ${repo} ${tag}\n${lines.join("\n")}${statusLine}`;

        const stepBar = steps.map((_, i) => {
            let icon = "⬛";
            if (i < currentStep) icon = "🟩";
            else if (i === currentStep) icon = "🟦";
            return `${icon}`;
        });
        const padding = steps.map((_, i) => {
            let icon = "";
            if (i < currentStep) icon = "<:blank:1383946250839396362>";
            else if (i === currentStep) icon = "";
            return `${icon}`;
        });
        let statusLine = "";
        if (
            status === "failed" && currentStep >= 0 &&
            currentStep < steps.length
        ) {
            statusLine = ` ❌ Failed`;
        } else if (status) {
            statusLine = ``;
        }
        const done = currentStep >= steps.length;
        if (done) {
            return `### ${repo.split("/").at(1)} ${tag}\n${
                stepBar.join("")
            }\nDone! ${statusLine}`;
        }
        return `### ${repo.split("/").at(1)} ${tag}\nStep ${
            currentStep + 1
        } / ${steps.length}\n${stepBar.join("")}\n${padding.join("")}  ^ ${
            steps[currentStep] || ""
        }${statusLine}${errorMessage ? `\nError: ${errorMessage}` : ""}`;
    }

    const res = await fetch(webhookUrl + "?wait=true&with_components=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        error("Failed to send Discord log:", res.statusText);
        return async () => {};
    }
    const data = await res.json();
    messageId = data.id;
    return async function updateStep(stepIdx: number, status?: string, errorMessage?: string) {
        currentStep = stepIdx;
        payload.components[0].components[0].content = renderContent(
            repo,
            tag,
            steps,
            currentStep,
            status,
            errorMessage,
        );
        if (status === "failed") {
            payload.components[0].accent_color = 15158332;
        } else if (status === "done") {
            payload.components[0].accent_color = 3066993;
        } else {
            payload.components[0].accent_color = 3447003;
        }
        await fetch(
            `${webhookUrl}/messages/${messageId}?wait=true&with_components=true`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            },
        );
    };
}

const app = express();
const port = 5008;
const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
    error("WEBHOOK_SECRET environment variable is required");
    process.exit(1);
}
const projectsPath = resolve("./projects.json");

app.use("/webhook", bodyParser.raw({ type: "*/*" }));

function verifySignature(req: express.Request, secret: string): boolean {
    const sigHeader = req.headers["x-hub-signature-256"] as string;
    if (!sigHeader || !sigHeader.startsWith("sha256=")) {
        warn("Missing or malformed signature header");
        return false;
    }

    const sig = Buffer.from(sigHeader.slice(7), "hex");
    const hmac = crypto.createHmac("sha256", secret);
    const digest = Buffer.from(hmac.update(req.body).digest("hex"), "hex");

    try {
        const valid = crypto.timingSafeEqual(digest, sig);
        if (!valid) {
            warn("Signature does not match");
        }
        return valid;
    } catch (err) {
        error("Error comparing signatures:", err);
        return false;
    }
}

app.post("/webhook", async (req, res) => {
    info("Webhook received");
    if (!verifySignature(req, secret)) {
        warn("Signature verification failed");
        return void res.status(401).send("Unauthorized").end();
    }

    let payload: any;
    try {
        payload = JSON.parse(req.body.toString());
        debug("Payload parsed successfully");
    } catch (e) {
        error("Failed to parse JSON payload:", e);
        return void res.status(400).send("Invalid JSON").end();
    }
    const action = payload.action;
    const repo = payload.repository?.full_name;
    const releaseTag = payload.release?.tag_name;

    if (!repo || !releaseTag) {
        info("Not a release payload; ignored");
        return void res.status(200).send("Not a release payload; ignored")
            .end();
    }

    if (action !== "published") {
        info("Action is not 'published'; ignored");
        return void res.status(200).send("Action not published; ignored").end();
    }

    let projects;
    try {
        projects = JSON.parse(fs.readFileSync(projectsPath, "utf-8"));
        debug("Loaded projects.json");
    } catch (err) {
        error("Failed to read projects.json:", err);

        return void res.status(500).send("Server error").end();
    }

    const config = projects[repo];
    if (!config) {
        warn(`Ignoring untracked repo: ${repo}`);
        return void res.status(404).send("Repo not found").end();
    }

    if (config.path.startsWith("app/")) {
        debug(
            `[${repo}] Rewriting path from ${config.path} to /home/tally/apps/...`,
        );
        config.path = config.path.replace(/^app\//, "/home/tally/apps/");
    }

    info(`[${repo}] Release ${releaseTag} received, deploying...`);
    res.status(200).send("OK").end();
    let updateDiscordStep: (stepIdx: number, status?: string, errorMessage?: string) => Promise<void> =
        async () => {};
    let currentStep = 0;
    try {
        updateDiscordStep = await createDiscordStepUpdater(repo, releaseTag);
        await handleRelease(
            config,
            releaseTag,
            repo,
            async (stepIdx, status, errorMessage) => {
                currentStep = stepIdx;
                await updateDiscordStep(stepIdx, status, errorMessage);
            },
        );
        success(`[${repo}] Deployment finished for tag ${releaseTag}`);
        await updateDiscordStep(5, "done");
    } catch (err) {
        error(`[${repo}] Deployment failed:`, err);
        await updateDiscordStep(currentStep, "failed", (err instanceof Error ? err.message : String(err)));
    }
});

app.listen(port, () => {
    info(`running on port ${port}`);
});
