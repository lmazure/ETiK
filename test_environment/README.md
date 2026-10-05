# Test dev container

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

If you need to access other Web sites than the currently authorized ones, modify `.devcontainer/init-firewall.sh` and restart the container.
