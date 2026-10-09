import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const hostedCode = await readFile(new URL('../client-host/client.js', import.meta.url), 'utf8')
if (hostedCode !== code) throw new Error('client-host/client.js is not synchronized with lib/client.js')
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
if (registration?.id !== 'dsh-viztools-client-host' || typeof registration.factory !== 'function') {
  throw new Error('client bundle did not register the dsh-viztools-client-host module')
}
const exports = registration.factory(() => {
  throw new Error('client bundle unexpectedly requested an external at materialization')
})
if (typeof exports.apply !== 'function' || exports.name !== 'dsh-viztools-client') {
  throw new Error('client bundle factory returned invalid exports')
}
