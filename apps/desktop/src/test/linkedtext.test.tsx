import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LinkedText, splitLinks } from "../components/task/LinkedText";

describe("links in task text", () => {
  it("finds web addresses and leaves trailing punctuation and other text alone", () => {
    const parts = splitLinks("see https://app.clickup.com/t/26441883/869fp12dv ,10:12, https://example.com/a. and javascript:alert(1)");
    expect(parts.filter((p) => p.url).map((p) => p.url)).toEqual([
      "https://app.clickup.com/t/26441883/869fp12dv",
      "https://example.com/a",
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("see https://app.clickup.com/t/26441883/869fp12dv ,10:12, https://example.com/a. and javascript:alert(1)");
  });

  it("renders only http(s) addresses as links", () => {
    render(<p><LinkedText text="Open https://app.clickup.com/t/1 or file:///C:/x or javascript:alert(1)" /></p>);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://app.clickup.com/t/1");
  });
});
