/** io.js —— 终端输入：确认框和主循环共用同一个 readline，避免两边抢 stdin */
import { createInterface } from 'node:readline/promises';

let rl;

export function getReadline() {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

/**
 * 等价于 Python 的 input(prompt)，只不过是异步的。
 * stdin 已经结束时（管道输入读完、Ctrl-D）返回空串，让调用方当作退出处理。
 */
export async function askLine(prompt) {
  try {
    return await getReadline().question(prompt);
  } catch (err) {
    if (String(err.message).includes('readline was closed')) return '';
    throw err;
  }
}

export function closeInput() {
  rl?.close();
  rl = undefined;
}
