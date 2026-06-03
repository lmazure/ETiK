# ETiK - Exploratory Testing is King

Some experiments with using AI for Exploratory Testing.

This repository is (and will stay) ver messy.

Experimenting with Claude Code and Playwright CLI impressed me a lot. But there are much too many commands to be approved. So Claude Code needs to be run in YOLO mode. I am currently focused on how to do this safely.

1) Run the VS Code Command `Dev Containers: Rebuild and Reopen in Container` in the image has not been built yet, otherwise run `Dev Containers: Reopen in Container`.
1) Start a shell
    1) Run `cat '"theme": "dark"' > ~/.claude/settings.json`.
    1) Run `claude --dangerously-skip-permissions`.