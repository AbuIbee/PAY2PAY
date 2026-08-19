import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingBanner } from "./OnboardingBanner";

describe("OnboardingBanner", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("shows personal-profile copy (paying vs. receiving) for kind=personal", async () => {
    render(<OnboardingBanner kind="personal" />);
    expect(await screen.findByText(/welcome to pay2pay/i)).toBeInTheDocument();
    expect(screen.getByText(/making repayment/i)).toBeInTheDocument();
    expect(screen.getByText(/receiving repayment/i)).toBeInTheDocument();
  });

  it("shows business-profile copy (staff, business-owned accounts) for kind=business", async () => {
    render(<OnboardingBanner kind="business" />);
    expect(await screen.findByText(/welcome to pay2pay/i)).toBeInTheDocument();
    expect(screen.getByText(/organization.*staff/i)).toBeInTheDocument();
  });

  it("dismissing hides the banner and the dismissal persists across remounts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<OnboardingBanner kind="personal" />);
    await user.click(await screen.findByRole("button", { name: /got it/i }));
    await waitFor(() => expect(screen.queryByText(/welcome to pay2pay/i)).not.toBeInTheDocument());
    unmount();

    render(<OnboardingBanner kind="personal" />);
    await waitFor(() => expect(screen.queryByText(/welcome to pay2pay/i)).not.toBeInTheDocument());
  });
});
