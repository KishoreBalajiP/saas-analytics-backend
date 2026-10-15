# Analivo UI/UX Gap Analysis

The frontend has broad public, tenant and admin route coverage with loading/error states. The primary gap is misleading availability: settings and several provider/operational features are explicit 501/stub paths. Frontend API/component tests are heavily mocked and therefore do not establish backend or production integration. React `act(...)` warnings were observed; React error #418 needs a production browser reproduction with extensions disabled before assigning cause.
