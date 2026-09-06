import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

// React 19's `act` needs this flag to run effects synchronously in tests.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
