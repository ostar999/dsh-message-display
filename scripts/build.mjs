/**
 * 构建脚本：本插件是纯 JavaScript 双半边（无 TS/无打包器），
 * 「构建」就是把 src 下的两个入口复制到 lib 下（exports 指向 lib）。
 * lib 产物已提交，安装方无需执行本脚本；只有改过 src 之后才需要重新构建。
 */
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
mkdirSync(join(root, 'lib'), { recursive: true })

for (const name of ['index.js', 'client.js']) {
  cpSync(join(root, 'src', name), join(root, 'lib', name))
  console.log(`built lib/${name}`)
}
