import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// `findBy*`/`waitFor` default to a 1000ms ceiling, which a fully parallel jsdom run
// (every test file in its own worker) can exceed for a slow-to-render page — the
// root cause of the intermittent Vendors failures, which reproduce at the Block 11
// baseline. Raising the ceiling only lets an *eventually-true* assertion finish; it
// never makes a wrong assertion pass, and passing tests are not slowed at all.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
