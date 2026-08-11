# SVN MCP Server

A complete MCP (Model Context Protocol) server for Subversion (SVN) integration, designed to let AI agents manage SVN repositories efficiently.

## 🎯 Features

- ✅ **Basic repository operations**: info, status, log, diff, checkout, update
- ✅ **File management**: add, commit, delete, revert
- ✅ **Maintenance tools**: cleanup
- 🔄 **Branch management**: (In development)
- 🔄 **Advanced operations**: merge, switch, properties (In development)
- 🔄 **Analysis tools**: blame, conflict detection (In development)
- 🔄 **Batch operations**: (In development)

## 📋 Requirements

- **Node.js** >= 18.0.0
- **Subversion (SVN)** installed and available on PATH
- **TypeScript** (for development)

### 🔍 Detecting the SVN installation

#### Check whether SVN is installed

```bash
# Basic command to check SVN
svn --version

# Check the full path of the executable
where svn        # Windows
which svn        # Linux/Mac

# Check the full SVN client
svn --version --verbose
```

#### Expected output if SVN is correctly installed:

```
svn, version 1.14.x (r1876290)
   compiled Apr 13 2023, 17:22:07 on x86_64-pc-mingw32

Copyright (C) 2023 The Apache Software Foundation.
This software consists of contributions made by many people;
see the NOTICE file for more information.
Subversion is open source software, see http://subversion.apache.org/
```

#### ❌ Common errors if SVN is NOT installed:

```bash
# Windows
'svn' is not recognized as an internal or external command

# Linux/Mac
svn: command not found
bash: svn: command not found
```

#### 🛠️ Advanced diagnostics

```bash
# Check the system PATH
echo $PATH                    # Linux/Mac
echo %PATH%                   # Windows CMD
$env:PATH                     # Windows PowerShell

# Search for SVN executables on the system
find / -name "svn" 2>/dev/null           # Linux
Get-ChildItem -Path C:\ -Name "svn.exe" -Recurse -ErrorAction SilentlyContinue  # Windows PowerShell

# Check the specific client version
svn --version | head -1       # Get just the first line with the version
```

### 💾 Installing SVN on Windows

#### Option 1: Package managers

```bash
# Using Chocolatey (Recommended)
choco install subversion

# Using winget
winget install CollabNet.Subversion

# Using Scoop
scoop install subversion
```

#### Option 2: Official installers

1. **TortoiseSVN** (includes the command-line client):
   ```
   https://tortoisesvn.net/downloads.html
   ✅ Includes GUI and CLI clients
   ✅ Windows Explorer integration
   ```

2. **SlikSVN** (command line only):
   ```
   https://sliksvn.com/download/
   ✅ Lightweight (CLI only)
   ✅ Ideal for automation
   ```

3. **CollabNet Subversion**:
   ```
   https://www.collab.net/downloads/subversion
   ✅ Enterprise version
   ✅ Commercial support available
   ```

#### Option 3: Visual Studio or Git for Windows

```bash
# If you have Git for Windows installed, it can include SVN
git svn --version

# Visual Studio can also include SVN
# Go to: Visual Studio Installer > Modify > Individual Components > Subversion
```

### 🐧 Installing SVN on Linux

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install subversion

# CentOS/RHEL/Fedora
sudo yum install subversion        # CentOS 7
sudo dnf install subversion        # CentOS 8/Fedora

# Arch Linux
sudo pacman -S subversion

# Alpine Linux
sudo apk add subversion
```

### 🍎 Installing SVN on macOS

```bash
# Homebrew (Recommended)
brew install subversion

# MacPorts
sudo port install subversion

# From Xcode Command Line Tools (may already be included)
xcode-select --install
```

### 🔧 Configuring SVN after installation

#### Check the global configuration

```bash
# Show current configuration
svn config --list

# Configure the global user
svn config --global auth:username your_username

# Configure the default editor
svn config --global editor "code --wait"     # VS Code
svn config --global editor "notepad"         # Windows Notepad
svn config --global editor "nano"            # Linux/Mac nano
```

#### Check repository access

```bash
# Test connection to a repository (without checking out)
svn list https://svn.example.com/repo/trunk

# Test with specific credentials
svn list https://svn.example.com/repo/trunk --username user --password password
```

## 🚀 Installation

### From NPM

```bash
npm install -g @grec0/mcp-svn
```

### Local Development

```bash
git clone https://github.com/gcorroto/mcp-svn.git
cd mcp-svn
npm install
npm run build
```

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SVN_PATH` | Path to the SVN executable | `svn` |
| `SVN_WORKING_DIRECTORY` | Local working copy directory | `process.cwd()` |
| `SVN_URL` (alias: `SVN_REPOSITORY_URL`) | Repository URL. Enables URL-only workflows and `/trunk/...` target resolution | - |
| `SVN_USERNAME` | Authentication user | - |
| `SVN_PASSWORD` | Authentication password | - |
| `SVN_USE_AUTH_CACHE` | Use svn's credential cache (`~/.subversion/auth`) instead of passing credentials on the command line | `false` |
| `SVN_TIMEOUT` | Timeout in milliseconds | `30000` |

### Credential handling

The password is **never** included in any string this server returns. `SvnResponse.command`
and every error message are built from a redacted copy of the argv (`--password ***`), so a
secret cannot reach a transcript, a log, or an agent's context. The real credentials still go
to the `svn` process unchanged, so authentication is unaffected.

The command line itself remains a weaker boundary: on most systems any local process can read
another process's argv. Where the credential cache is already populated, set
`SVN_USE_AUTH_CACHE=true` so the credentials are left off the command line entirely. Commands
that explicitly bypass the cache (`--no-auth-cache`, used to recover from `E215004`) still send
them.

**Cache-only setup (recommended):** with the cache populated, drop `SVN_USERNAME` and
`SVN_PASSWORD` from the configuration entirely and keep only `SVN_USE_AUTH_CACHE=true`. No
password in the config file, none in argv. On Windows the cache
(`%APPDATA%\Subversion\auth\svn.simple`) is encrypted with DPAPI. Populate it once by running
`svn info <repo-url> --username <user>` by hand and answering the prompt. Two consequences:

- `svn_clear_credentials` becomes irreversible from the MCP — with no password in the
  environment, nothing can repopulate the cache. Recover by running that same `svn info` again.
- `svn_diagnose` probes with `--no-auth-cache`, so that one check reports an authentication
  failure. It is a diagnostic; normal operations are unaffected.

Paths are resolved against `SVN_WORKING_DIRECTORY`, not against the process working directory. A
relative path therefore lands inside the working copy, which is where svn itself runs — before, it
resolved against wherever Node happened to start and svn answered "not a working copy", an error that
pointed at the repository instead of at the path.

Working-copy-only commands (`svn_status`, `svn_delete`) also accept a repo-relative path (`/trunk/x.sql`)
and map it into the working copy; they refuse a URL, because svn does not accept one for them.

`svn_checkout` and `svn_update` default to a **300 s** timeout instead of the global 30 s — fetching a
real module branch over the network routinely needs more, and the timeout kills the process with a
signal that gives no hint that time was the cause. Every slow command also takes a per-call `timeout`.

`svn_update` exposes `setDepth`, which is how a single folder or file is pulled into an otherwise sparse
working copy — the difference between fetching one branch and fetching all of a module's branches.

`SVN_WORKING_DIRECTORY` and `SVN_URL` are independent — set either or both. With both configured, local operations (`svn_status`, `svn_commit`, ...) run in the working copy, and URL-capable tools (`svn_cat`, `svn_list`, `svn_info`, `svn_log`, `svn_diff`) can be called with:

- a full URL (`https://svn.example.com/repo/trunk/file.sql`)
- a repo-relative path starting with `/` (`/trunk/file.sql`) — joined with `SVN_URL`
- a local path — resolved against the working copy

### Example MCP Configuration

```json
{
  "mcpServers": {
    "svn": {
      "command": "node",
      "args": [
        "C:/path/to/mcp/directory/dist/index.js"
      ],
      "env": {
        "SVN_PATH": "svn",
        "SVN_REPOSITORY_URL": "https://svn.kmm.com.br/producao",
        "SVN_WORKING_DIRECTORY": "C:/path/to/working/copy",
        "SVN_USE_AUTH_CACHE": "true"
      }
    }
  }
}
```

## 🛠️ Available Tools

### Basic Operations

#### `svn_health_check`
Check the health status of the SVN system and working copy.

```
svn_health_check()
```

#### `svn_info`
Get detailed information about the working copy or a specific file.

```
svn_info(path?: string)
```

#### `svn_status`
Show the status of files in the working copy.

```
svn_status(path?: string, showAll?: boolean)
```

#### `svn_log`
Show the commit history of the repository.

```
svn_log(path?: string, limit?: number, revision?: string)
```

#### `svn_diff`
Show differences between file revisions.

```
svn_diff(path?: string, oldRevision?: string, newRevision?: string)
```

### Repository Operations

#### `svn_checkout`
Check out an SVN repository.

```
svn_checkout(
  url: string,
  path?: string,
  revision?: number | "HEAD",
  depth?: "empty" | "files" | "immediates" | "infinity",
  force?: boolean,
  ignoreExternals?: boolean
)
```

#### `svn_update`
Update the working copy from the repository.

```
svn_update(
  path?: string,
  revision?: number | "HEAD" | "BASE" | "COMMITTED" | "PREV",
  force?: boolean,
  ignoreExternals?: boolean,
  acceptConflicts?: "postpone" | "base" | "mine-conflict" | "theirs-conflict" | "mine-full" | "theirs-full"
)
```

### File Management

#### `svn_add`
Add files to version control.

```
svn_add(
  paths: string | string[],
  force?: boolean,
  noIgnore?: boolean,
  parents?: boolean,
  autoProps?: boolean,
  noAutoProps?: boolean
)
```

#### `svn_commit`
Commit changes to the repository. **Two steps:** the first call previews and writes nothing; a second
call with `confirm: true` performs it.

```
svn_commit(
  message: string,
  paths: string[],          // REQUIRED, at least one
  confirm?: boolean,        // default false -> preview only
  file?: string,
  force?: boolean,
  keepLocks?: boolean,
  noUnlock?: boolean,
  timeout?: number
)
```

⚠ `paths` is required, and that is a deliberate breaking change. With no targets, `svn commit` sweeps
every modified file under the working-copy root into a single revision — and a working copy rooted at a
repository root spans every project in it. A commit cannot be edited afterwards, so a whole-tree commit
has to be an explicit act: pass the root path if that is really what you want.

The preview lists the `svn status` of each target, and says so when none of them has a local
modification.

#### `svn_delete`
Remove files from version control, **in the working copy**.

```
svn_delete(
  paths: string | string[],
  force?: boolean,
  keepLocal?: boolean
)
```

⚠ `message` was removed. It only ever applied to a delete straight against a repository URL, and that
path was unreachable — the URL was silently turned into a local path. A URL is now refused with a
message saying why: deleting from the repository is immediate and irreversible.

#### `svn_revert`
Revert local changes on files.

```
svn_revert(paths: string | string[])
```

### Maintenance Tools

#### `svn_cleanup`
Clean up the working copy from interrupted operations.

```
svn_cleanup(path?: string)
```

## 📖 Usage Examples

### Check the system status

```javascript
// Check that SVN is available and the working copy is valid
const healthCheck = await svn_health_check();
```

### Get repository information

```javascript
// General working copy information
const info = await svn_info();

// Information about a specific file
const fileInfo = await svn_info("src/main.js");
```

### Show file status

```javascript
// Status of all files
const status = await svn_status();

// Status including remote information
const fullStatus = await svn_status(null, true);
```

### Check out a repository

```javascript
const checkout = await svn_checkout(
  "https://svn.example.com/repo/trunk",
  "local-copy",
  "HEAD",
  "infinity",
  false,
  false
);
```

### Commit changes

```javascript
// Add files
await svn_add(["src/new-file.js", "docs/readme.md"], { parents: true });

// Commit
await svn_commit(
  "Add new feature and documentation",
  ["src/new-file.js", "docs/readme.md"]
);
```

## 🧪 Testing

```bash
# Run tests
npm test

# Tests with coverage
npm run test -- --coverage

# Tests in watch mode
npm run test -- --watch
```

## 🏗️ Development

### Available scripts

```bash
# Build TypeScript
npm run build

# Development mode
npm run dev

# Watch mode
npm run watch

# MCP Inspector
npm run inspector

# Tests
npm test

# Publish a new version
npm run release:patch
npm run release:minor
npm run release:major
```

### Project structure

```
svn-mcp/
├── package.json
├── tsconfig.json
├── jest.config.js
├── index.ts
├── common/
│   ├── types.ts      # TypeScript types
│   ├── utils.ts      # SVN utilities
│   └── version.ts    # Package version
├── tools/
│   └── svn-service.ts # Main SVN service
├── tests/
│   └── integration.test.ts # Integration tests
└── README.md
```

## 📊 Development Status

See the [SVN_MCP_IMPLEMENTATION.md](./SVN_MCP_IMPLEMENTATION.md) file for the full implementation checklist.

**Current progress:** Stage 1 complete (Basic Operations) ✅

**Next stages:**
- Branch management (branching)
- Advanced operations (merge, switch)
- Analysis tools
- Batch operations

## 🐛 Troubleshooting

### SVN not found

```
Error: SVN is not available in the system PATH
```

**Solution:** Install SVN and make sure it is on the system PATH.

### Not a working copy

```
Error: Failed to get SVN info: svn: warning: W155007: '.' is not a working copy
```

**Solution:** Navigate to a directory that is an SVN working copy or run checkout first.

### Authentication issues

```
Error: svn: E170001: Authentication failed
```

**Solution:** Set the `SVN_USERNAME` and `SVN_PASSWORD` environment variables.

### Timeouts on long operations

```
Error: Command timeout after 30000ms
```

**Solution:** Increase the value of `SVN_TIMEOUT`.

## 📄 License

MIT License - see [LICENSE](LICENSE) for more details.

## 🤝 Contributing

1. Fork the project
2. Create a feature branch (`git checkout -b feature/new-feature`)
3. Commit your changes (`git commit -am 'Add new feature'`)
4. Push to the branch (`git push origin feature/new-feature`)
5. Open a Pull Request

## 📞 Support

- **Issues:** [GitHub Issues](https://github.com/gcorroto/mcp-svn/issues)
- **Documentation:** [Project Wiki](https://github.com/gcorroto/mcp-svn/wiki)
- **Email:** soporte@grec0.dev
