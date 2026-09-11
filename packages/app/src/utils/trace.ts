// [TRACE] 临时诊断工具：统一以页面加载（performance.now）为基准打点。
// 同时**同步**落盘到 localStorage（key: duoduo:trace），便于程序卡死后取证：
//   - 程序启动时（entry.tsx 调用 flushCrashTrace）会把上次遗留的 trace
//     写到 $TEMP/duoduo-trace-last.log 并清空；即使主线程彻底卡死，
//     重启后也能拿到「卡死前最后一步」（localStorage 在进程被杀后持久化）。
//   - 配合 entry.tsx 的 BLOCKED 心跳可区分两种卡死：
//       · 日志里有 `BLOCKED xxx ms` → 主线程被单次超长同步任务占住；
//       · 日志里没有 BLOCKED，且脚步停在某个 await 之后 → 后端请求永久 pending。
// 定位「打开项目卡死」后连同本文件一并删除。
const TRACE_KEY = "duoduo:trace"
export function trace(label: string): void {
  const line = `[TRACE] +${performance.now().toFixed(1)}ms ${label}`
  try {
    const w = window as unknown as { __trace?: string[] }
    if (!w.__trace) w.__trace = []
    w.__trace.push(line)
  } catch {
    /* ignore */
  }
  try {
    let arr: string[] = []
    const raw = localStorage.getItem(TRACE_KEY)
    if (raw) arr = JSON.parse(raw)
    arr.push(line)
    if (arr.length > 1000) arr = arr.slice(arr.length - 1000)
    localStorage.setItem(TRACE_KEY, JSON.stringify(arr))
  } catch {
    /* ignore */
  }
  console.log(line)
}
