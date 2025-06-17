#! /bin/bash

npm install
npm run build
if [ $? -ne 0 ]; then
    echo "Build failed. Exiting."
    exit 1
fi
npm run start
if [ $? -ne 0 ]; then
    echo "Start failed. Exiting."
    exit 1
fi
