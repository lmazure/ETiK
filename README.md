# ETiK - Exploratory Testing is King

Some experiments with using AI for Exploratory Testing.

This repository is (and will stay) very messy.

Experimenting with Claude Code and Playwright CLI impressed me a lot. But there are much too many commands to be approved. So Claude Code needs to be run in YOLO mode. I am currently focused on how to do this safely.

The first time, in VS Code:
1) Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).
1) Execute the command `Dev Containers: Rebuild and Reopen in Container`.
1) Execute the command `Terminal: Create New Terminal`.
1) In the new terminal, run `claude --dangerously-skip-permissions`.

Then, the next times:
1) Execute the command `Dev Containers: Reopen in Container`.
1) Execute the command `Terminal: Create New Terminal`.
1) In the new terminal, run `claude --dangerously-skip-permissions`.

