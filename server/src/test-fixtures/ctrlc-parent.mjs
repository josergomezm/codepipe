// Stand-in for the CodePipe server in a real console window: it spawns a
// child with the given options; the child sends a console Ctrl+C to its whole
// console (process group 0), as a CLI does when it interrupts a command. We
// record whether that Ctrl+C reached this process as SIGINT.
// Usage: node ctrlc-parent.mjs <resultFile> '<spawn options JSON>'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [resultFile, optionsJson] = process.argv.slice(2)
const ps = "Add-Type -Name K -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'; [W.K]::GenerateConsoleCtrlEvent(0, 0) | Out-Null; Start-Sleep -Milliseconds 500"

let gotSigint = false
process.on('SIGINT', () => { gotSigint = true })
const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', ...JSON.parse(optionsJson) })
child.on('close', () => setTimeout(() => {
  writeFileSync(resultFile, JSON.stringify({ gotSigint }))
  process.exit(0)
}, 700))
