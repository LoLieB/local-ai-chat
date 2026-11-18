import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emitKeypressEvents } from "node:readline";
import { checkPortAvailable, isSupportedNodeVersion, parsePort, createDependencyFingerprint, REQUIRED_DEPENDENCY_FILES } from "./portable-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const [action, language] = process.argv.slice(2);
const tr = (ru, en) => language === "ru" ? ru : en;
const say = (ru, en) => console.log(tr(ru, en));
const lockPath = join(root, ".windows-launch.lock");
let lock, child;
function cleanup() {
  if (child && child.exitCode === null) child.kill();
  if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); lock = undefined; }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
function acquireLock() {
  try { lock = openSync(lockPath, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(readFileSync(lockPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error(tr("Повреждён файл блокировки. Закройте окно запуска и обратитесь к руководству.", "Invalid lock file. Close the launcher and consult the guide."));
    try { process.kill(pid, 0); }
    catch (probe) { if (probe.code === "ESRCH") { unlinkSync(lockPath); lock = openSync(lockPath, "wx"); } else throw probe; }
    if (lock === undefined) return false;
  }
  writeFileSync(lock, String(process.pid));
  return true;
}
function run(args, input) {
  return new Promise((done, fail) => {
    child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"] });
    child.once("error", fail); child.once("exit", code => done(code));
    if (input !== undefined) child.stdin.end(input);
  });
}
function secret(label) {
  if (!process.stdin.isTTY) throw Error(tr("Пароль вводится только в интерактивном окне установщика.", "Enter the password in the interactive installer window."));
  console.log(label);
  return new Promise(resolveSecret => {
    let value = "";
    emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === "c") process.exit(130);
      if (key.name === "return") {
        process.stdin.off("keypress", onKey); process.stdin.setRawMode(false); process.stdin.pause(); console.log(); resolveSecret(value);
      } else if (key.name === "backspace") value = [...value].slice(0, -1).join("");
      else if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(text)) value += text;
    };
    process.stdin.on("keypress", onKey);
  });
}
async function health(url) {
  try { return await (await fetch(url + "api/health", { signal: AbortSignal.timeout(1000) })).json(); } catch { return null; }
}
function openBrowser(url) {
  const opener = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, stdio: "ignore" });
  opener.on("error", () => console.log(url));
}
try {
  if (process.platform !== "win32" || process.arch !== "x64") throw Error(tr("Этот сценарий проверяется для Windows x64.", "This launcher targets Windows x64."));
  if (!isSupportedNodeVersion(process.version)) throw Error(tr("Установите совместимую LTS-версию Node.js с https://nodejs.org/en/download и повторите запуск.", "Install a compatible Node.js LTS from https://nodejs.org/en/download and try again."));
  if (!["install", "start"].includes(action)) throw Error("Unknown launcher action.");
  const portLine = existsSync(".env") ? readFileSync(".env", "utf8").split(/\r?\n/).find(line => /^\s*PORT\s*=/.test(line)) : undefined;
  const configuredPort = portLine?.split("=").slice(1).join("=").split("#")[0].trim().replace(/^["']|["']$/g, "");
  const port = parsePort(configuredPort || process.env.PORT, 8787, "PORT");
  const url = `http://127.0.0.1:${port}/`;
  if (!acquireLock()) {
    const running = await health(url);
    if (action === "start" && running?.service === "local-ai-chat") { openBrowser(url); say("Приложение уже запущено.", "The application is already running."); }
    else throw Error(tr("Подготовка или запуск уже выполняется. Дождитесь завершения другого окна.", "Setup or startup is already running. Wait for the other window."));
  } else {
    if (!(await checkPortAvailable({ host: "127.0.0.1", port })).available) throw Error(tr(`Порт ${port} занят. Закройте использующую его программу или обратитесь к руководству. Процессы не остановлены.`, `Port ${port} is occupied. Close its application or consult the guide. No processes were stopped.`));
    if (action === "install") {
      const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
      if (!existsSync(npm)) throw Error(tr("Рядом с Node.js нет npm. Повторите установку Node.js с компонентом npm.", "npm is missing beside Node.js. Reinstall Node.js including npm."));
      const fingerprint = process.version + ":" + createDependencyFingerprint(readFileSync("package.json"), readFileSync("package-lock.json"));
      const installed = existsSync(".windows-dependencies") && readFileSync(".windows-dependencies", "utf8") === fingerprint && REQUIRED_DEPENDENCY_FILES.every(file => existsSync(file));
      if (!installed) {
        say("Подготовка зависимостей из npm. Нужен интернет; данные аккаунтов сохраняются.", "Installing dependencies from npm. Internet is required; account data is preserved.");
        if (await run([npm, "ci", "--include=dev", "--no-audit", "--no-fund"]) !== 0) throw Error(tr("Зависимости не установлены. Проверьте интернет и права записи, затем повторите установку.", "Dependency installation failed. Check internet and write access, then retry."));
        writeFileSync(".windows-dependencies", fingerprint);
      } else say("Готовые зависимости используются повторно.", "Reusing prepared dependencies.");
      if (await run([npm, "run", "build"]) !== 0) throw Error(tr("Сборка не удалась. Сохраните текст ошибки выше.", "Build failed. Keep the error shown above."));
      if (!existsSync(".env")) writeFileSync(".env", "HOST=127.0.0.1\nPORT=8787\nSERVER_TOKEN=\nINITIAL_ADMIN_PASSWORD=\n", { flag: "wx" });
      const args = ["--import", "tsx", "scripts/setup-admin.ts"];
      const check = await run([...args, "--check"]);
      if (check === 10) {
        const password = await secret(tr("Придумайте пароль admin: 12–256 символов. Ввод скрыт. Нажмите Enter.", "Choose an admin password: 12–256 characters. Input is hidden. Press Enter."));
        const confirm = await secret(tr("Повторите пароль и нажмите Enter.", "Repeat the password and press Enter."));
        if (password !== confirm || password.trim().length < 12 || password.length > 256) throw Error(tr("Пароли не совпадают или длина неверна. Повторите установку.", "Passwords differ or have invalid length. Run setup again."));
        if (await run(args, password) !== 0) throw Error(tr("Не удалось создать администратора.", "Administrator setup failed."));
      } else if (check !== 0) throw Error(tr("Проверка аккаунтов не пройдена. Данные не сброшены.", "Account validation failed. Data was not reset."));
      say("Подготовка завершена. Откройте 2_ЗАПУСТИТЬ.bat. Логин: admin.", "Setup complete. Open 2_START.bat. Username: admin.");
    } else {
      if (!existsSync("dist/index.html") || !existsSync("node_modules/tsx/package.json")) throw Error(tr("Сначала запустите 1_УСТАНОВИТЬ.bat.", "Run 1_INSTALL.bat first."));
      child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: root, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) }, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
      let launchError; child.on("error", error => { launchError = error; });
      let ready = false;
      for (let i = 0; i < 60; i++) {
        if (launchError || child.exitCode !== null) break;
        const state = await health(url);
        if (state?.service === "local-ai-chat" && state.pid === child.pid) {
          const response = await fetch(url + "api/ready", { signal: AbortSignal.timeout(1000) });
          if (response.ok && (await response.json()).ready) { ready = true; break; }
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 500));
      }
      if (!ready) throw Error(tr("Сервер не готов. Проверьте ошибку выше и повторите подготовку.", "Server did not become ready. Check the error above and run setup again."));
      openBrowser(url); console.log(url);
      say("Оставьте окно открытым. Для остановки нажмите Enter. LM Studio настраивается в разделе Настройки.", "Keep this window open. Press Enter to stop. Configure LM Studio in Settings.");
      let requestedStop = false;
      process.stdin.resume(); process.stdin.once("data", () => { requestedStop = true; process.stdin.pause(); cleanup(); });
      const exitCode = await new Promise(resolveExit => child.once("exit", resolveExit));
      process.stdin.pause();
      if (!requestedStop && exitCode !== 0) throw Error(tr("Сервер неожиданно завершился. Проверьте сообщение выше.", "Server exited unexpectedly. Check the message above."));
      say("Сервер остановлен.", "Server stopped.");
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
