import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let registration
vm.runInNewContext(code, {
  window: {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  },
})
if (registration?.id !== 'dsh-viztools' || typeof registration.factory !== 'function') {
  throw new Error('client bundle did not register the dsh-viztools module')
}
const exports = registration.factory(() => {
  throw new Error('client bundle unexpectedly requested an external at materialization')
})
if (typeof exports.apply !== 'function' || exports.name !== 'dsh-viztools-client') {
  throw new Error('client bundle factory returned invalid exports')
}
