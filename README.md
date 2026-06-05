# ETiK - Exploratory Testing is King

Some experiments with using AI for Exploratory Testing.

This repository is (and will stay) very messy.

Experimenting with Claude Code and Playwright CLI impressed me a lot. But there are much too many commands to be approved. So Claude Code needs to be run in YOLO mode. I am currently focused on how to do this safely.

The first time:
1) Run the VS Code Command `Dev Containers: Rebuild and Reopen in Container`.
1) Start a shell, then, in this one:
    1) Run `claude --dangerously-skip-permissions`.

Then
1) Run `Dev Containers: Reopen in Container`.
1) Start a shell, then, in this one:
    1) Run `claude --dangerously-skip-permissions`.
