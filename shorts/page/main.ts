import { startShorts } from '../app'
import '@tgdrive/ui/base.css'
import '../style.css'
try { startShorts() }
catch (error) { const message = document.getElementById('message')!; message.textContent = `短视频打开失败：${error instanceof Error ? error.message : '启动未能完成'}`; message.hidden = false }
