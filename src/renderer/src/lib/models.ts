import { monaco } from './monaco'

const models = new Map<string, monaco.editor.ITextModel>()

/** One Monaco model per open path, shared by editor panels. */
export function modelFor(path: string, content: string, language: string): monaco.editor.ITextModel {
  let m = models.get(path)
  if (!m || m.isDisposed()) {
    m = monaco.editor.createModel(content, language, monaco.Uri.file(path))
    models.set(path, m)
  } else if (m.getValue() !== content) {
    m.setValue(content)
  }
  return m
}

export function disposeModel(path: string): void {
  models.get(path)?.dispose()
  models.delete(path)
}
