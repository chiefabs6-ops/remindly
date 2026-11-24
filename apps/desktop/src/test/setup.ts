import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// findBy*/waitFor: allow for a busy machine when all screen tests run at once (default 1 s).
configure({ asyncUtilTimeout: 4000 });

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => cleanup());
