import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PasswordField } from "./PasswordField";

/**
 * Section J (closed-beta remediation, Product Owner review): a standard show/hide control for every
 * password-entry screen. Default must be masked; toggling must never affect what value is actually
 * submitted (only the input's `type`, not its `value`).
 */
describe("PasswordField", () => {
  it("defaults to masked and reveals/re-masks the value on toggle", async () => {
    const user = userEvent.setup();
    render(<PasswordField id="pw" name="password" label="Password" autoComplete="current-password" />);

    const input = screen.getByLabelText(/^password$/i);
    expect(input).toHaveAttribute("type", "password");

    await user.type(input, "correct horse battery staple");
    expect(input).toHaveValue("correct horse battery staple");

    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);

    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveValue("correct horse battery staple");
    expect(screen.getByRole("button", { name: /hide password/i })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /hide password/i }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("renders optional helper text and passes through validation attributes", () => {
    render(
      <PasswordField
        id="pw2"
        name="password"
        label="New password"
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={256}
        helperText="At least 8 characters."
      />,
    );

    const input = screen.getByLabelText(/new password/i);
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("minlength", "8");
    expect(input).toHaveAttribute("maxlength", "256");
    expect(screen.getByText("At least 8 characters.")).toBeInTheDocument();
  });
});
