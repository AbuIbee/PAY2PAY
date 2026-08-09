"use client";

interface SelectableProfile {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
  displayName: string;
}

export function ProfileSwitcher({
  profiles,
  activeKey,
  onSwitch,
}: {
  profiles: SelectableProfile[];
  activeKey: string;
  onSwitch: (profile: SelectableProfile) => void;
}) {
  return (
    <div className="field" style={{ maxWidth: "20rem" }}>
      <label htmlFor="profile-switcher">Viewing as</label>
      <select
        id="profile-switcher"
        value={activeKey}
        onChange={(event) => {
          const selected = profiles.find(
            (p) => (p.kind === "personal" ? "personal" : `business:${p.businessProfileId}`) === event.target.value,
          );
          if (selected) onSwitch(selected);
        }}
      >
        {profiles.map((profile) => {
          const key = profile.kind === "personal" ? "personal" : `business:${profile.businessProfileId}`;
          return (
            <option key={key} value={key}>
              {profile.displayName}
            </option>
          );
        })}
      </select>
    </div>
  );
}

export type { SelectableProfile };
