// Load .env so integration tests (and any test reading config) pick up local
// credentials/settings. Harmless for unit tests, which don't read provider env.
import "dotenv/config";
