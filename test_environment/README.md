# ETiK - Exploratory Testing is King

Some experiments with using AI for Exploratory Testing.

Experimenting with Claude Code and Playwright CLI impressed me a lot. But there are much too many commands to be approved. So Claude Code needs to be run in YOLO mode. Security is improved (but this is not perfect!) by running Claude Code in a DevContainer.

## Usage

The first time, in VS Code:
1) Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).
1) Execute the command `Dev Containers: Rebuild and Reopen in Container`.
1) Execute the command `Terminal: Create New Terminal`.
1) In the new terminal, run `claude --dangerously-skip-permissions`.

Then, the next times:
1) Execute the command `Dev Containers: Reopen in Container`.
1) Execute the command `Terminal: Create New Terminal`.
1) In the new terminal, run `claude --dangerously-skip-permissions`.

## Notes

You can use the `notes.md` file as a scratchpad, the AI agent cannot read/write it.

If you need to access other Web sites than the currently authorized ones, modify `.devcontainer/init-firewall.sh` and restart the container.
