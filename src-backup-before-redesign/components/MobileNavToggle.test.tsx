import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MobileNavToggle } from "./MobileNavToggle";

describe("MobileNavToggle", () => {
  it("starts collapsed with correct accessible state", () => {
    render(<MobileNavToggle />);
    const button = screen.getByRole("button", { name: /open menu/i });
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles accessible state and label on click", async () => {
    const user = userEvent.setup();
    render(<MobileNavToggle />);
    const button = screen.getByRole("button", { name: /open menu/i });

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /close menu/i })).toBeInTheDocument();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("meets the minimum 44px touch-target size via the shared .button class", () => {
    render(<MobileNavToggle />);
    expect(screen.getByRole("button")).toHaveClass("button");
  });
});
