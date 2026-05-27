## Installation

export PATH=$PATH:./node_modules/.bin/

install Pi
```bash
npm install --ignore-scripts @earendil-works/pi-coding-agent
```

launch Pi
```bash
pi
```

update Pi
```bash
npm update --ignore-scripts @earendil-works/pi-coding-agent
```

install Playwright CLI
```bash
npm install @playwright/cli
```

a simple scenario: snapshot the login page, login, snapshot the welcome page
```bash
playwright-cli open http://localhost:8090/squash/login
playwright-cli screenshot
playwright-cli fill e18 admin
playwright-cli fill e21 admin
playwright-cli click e24
playwright-cli screenshot
playwright-cli close
```

install Playwright skill
```bash
playwright-cli install --skill
```
This is stuck. This does not work currently with node 26 (https://github.com/microsoft/playwright/issues/40724) while I use 26.2.0.  
I need to downgrade node 24.16.0.  
The problem is still present.  

As last, here is the process to get the jow done:

### Installing Playwright with `--skills` on Windows (Git Bash + External SSD)

#### Steps

##### 1. Run the install command
```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "C:\Users\$env:USERNAME\AppData\Local\ms-playwright"
.\node_modules\.bin\playwright-cli install --skills
```

##### 2. When it hangs after a download, type Ctrl-C and run
```powershell
Get-ChildItem "C:\Users\$env:USERNAME\AppData\Local\ms-playwright" -Directory | Where-Object {
    -not (Test-Path "$($_.FullName)\INSTALLATION_COMPLETE")
} | ForEach-Object {
    Write-Host "Creating marker in $($_.FullName)"
    New-Item -ItemType File -Path "$($_.FullName)\INSTALLATION_COMPLETE"
}
```

##### 3. Re-run the install command
```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "C:\Users\$env:USERNAME\AppData\Local\ms-playwright"
.\node_modules\.bin\playwright-cli install --skills```

##### 4. Repeat steps 2 and 3 until you see
```
✅ Found chrome, will use it as the default browser.
```


#### Notes
- The hang is caused by a **Node 26 bug** where Playwright never writes the `INSTALLATION_COMPLETE` marker after extracting a download. See https://github.com/microsoft/playwright/issues/40724
- The `PLAYWRIGHT_BROWSERS_PATH` redirect to `C:` is necessary to avoid **filesystem locking issues** on external drives


Rename `.claude` into `.pi`.



## Notes on using Pi

| Command | Description |
| --------| ----------- |pl
| `/quit` | Quit Pi     |
| `/login` | Configure provider authentication |
| `/logout` | Remove provider authentication |
| `/model` | Select model |
| `/reload` | Reload keybindings, extensions, skills, prompts, and themes |
| `/session` | Show session info and stats |
| `/reload` | Reload keybindings, extensions, skills, prompts, and themes |
| `/skill<skill-name>` |  |
| `/export` |  |



