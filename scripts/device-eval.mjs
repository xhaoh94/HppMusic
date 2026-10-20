/**
 * 通过 Chrome DevTools Protocol 在设备上的 WebView 里执行 JS。
 *
 * 用途：安卓端界面排查。点按坐标猜不准、logcat 看不到 DOM，这个能直接问页面。
 * 依赖 Capacitor debug 构建默认开启的 WebView 调试（socket: @webview_devtools_remote_<pid>）。
 *
 * 用法：
 *   node scripts/device-eval.mjs "document.title"
 *   node scripts/device-eval.mjs --console 8        # 顺带收集 8 秒内的 console 输出
 *
 * 前置：
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.hppmusic.app)
 *   （Windows 上 adb 在 %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe，
 *    该命令要在 Git Bash 里跑；见 scripts/device-forward.sh）
 */
const CDP_HOST = process.env.CDP_HOST || 'http://127.0.0.1:9222';

const args = process.argv.slice(2);
const consoleSecondsIndex = args.indexOf('--console');
const consoleSeconds = consoleSecondsIndex >= 0 ? Number(args[consoleSecondsIndex + 1]) || 5 : 0;
// 只有确实传了 --console 才跳过它后面那个秒数参数；否则 indexOf 返回 -1，
// 加一之后是 0，会把第一个参数误过滤掉（脚本会静默什么都不做）。
const skippedIndex = consoleSecondsIndex >= 0 ? consoleSecondsIndex + 1 : -1;

// --viewport 450x800 : 用 CDP 覆盖设备指标，模拟别的屏幕尺寸/方向，不用重装 APK
const viewportIndex = args.indexOf('--viewport');
const viewportArg = viewportIndex >= 0 ? args[viewportIndex + 1] : null;
const viewport = viewportArg ? viewportArg.split('x').map(Number) : null;
const viewportSkip = viewportIndex >= 0 ? viewportIndex + 1 : -1;

const expression = args
  .filter((a, i) => !a.startsWith('--') && i !== skippedIndex && i !== viewportSkip)
  .join(' ');

const targets = await (await fetch(`${CDP_HOST}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('没有找到 page 目标，检查 adb forward 与应用是否在跑');
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

const consoleLines = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(
      `[${message.params.type}] ` +
        message.params.args
          .map((a) => ('value' in a ? String(a.value) : a.description ?? a.type))
          .join(' '),
    );
  } else if (message.method === 'Runtime.exceptionThrown') {
    consoleLines.push(`[exception] ${message.params.exceptionDetails.text}`);
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve);
  socket.addEventListener('error', reject);
});

await send('Runtime.enable', {});

if (viewport && viewport.length === 2 && viewport.every(Number.isFinite)) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: viewport[0],
    height: viewport[1],
    deviceScaleFactor: 2,
    mobile: true,
  });
  console.error(`[device-eval] 已把视口覆盖为 ${viewport[0]}x${viewport[1]}`);
}

if (expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.result?.exceptionDetails) {
    console.error('执行出错:', JSON.stringify(result.result.exceptionDetails, null, 2));
  } else {
    console.log(JSON.stringify(result.result?.result?.value ?? null, null, 2));
  }
}

if (consoleSeconds > 0) {
  await new Promise((r) => setTimeout(r, consoleSeconds * 1000));
  console.log(`--- console (${consoleSeconds}s) ---`);
  consoleLines.forEach((line) => console.log(line));
}

socket.close();
// 注意：不要在这里 process.exit(0)。stdout 是管道时写入是异步的，
// 立刻退出会把还没 flush 的输出丢掉（脚本会"什么都没有"但 exit 0）。
// 让 socket.close() 之后事件循环自然结束即可。
