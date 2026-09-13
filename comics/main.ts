import { startApp } from '../reader/app'
import { ComicReader } from './comic'
import { ComicCoverLoader } from './cover'
void startApp({
  kind: 'comics',
  create: async (context) => new ComicReader(context),
  createCoverLoader: (drive, signal) => new ComicCoverLoader(drive, signal),
})
  .catch((error) => { document.getElementById('app')!.textContent = `漫画打开失败：${error.message}` })
