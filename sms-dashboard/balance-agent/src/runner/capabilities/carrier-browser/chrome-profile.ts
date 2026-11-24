export function createTemporaryChromePreferences() {
  return {
    credentials_enable_service: false,
    profile: {
      password_manager_enabled: false,
      default_content_setting_values: {
        notifications: 2,
      },
    },
    autofill: {
      profile_enabled: false,
      credit_card_enabled: false,
    },
  };
}

export const TEMPORARY_CHROME_ARGS = Object.freeze([
  '--disable-notifications',
  '--disable-save-password-bubble',
  '--disable-features=PasswordManagerOnboarding,PasswordManagerRedesign,PasswordGeneration',
]);
