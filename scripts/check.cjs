'use strict'
const fs = require('fs')
const files = ['src/host.js', 'src/client.js']
let failed = false
for (const file of files) {
  let code
  try {
    code = fs.readFileSync(file, 'utf8')
  } catch (err) {
    console.error(file + ': 读取失败（文件尚不存在，跳过）')
    continue
  }
  try {
    new Function(code) // 仅编译，不执行
    console.log(file + ': OK')
  } catch (err) {
    failed = true
    console.error(file + ': 语法错误\n' + err.message)
  }
}
process.exit(failed ? 1 : 0)
