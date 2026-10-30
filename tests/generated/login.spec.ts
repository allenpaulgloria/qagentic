import { test, expect } from '../../src/fixtures/page.fixture.js';

// I am grouping functional tests for LoginPage covering Happy Path, Negative, and Edge Case scenarios.
test.describe('LoginPage Functional Suite', () => {
  test.beforeEach(async ({ loginPage }) => {
    // I am navigating to the login page prior to each test using the injected Page Object fixture.
    await loginPage.goto();
  });

  test('Happy Path: should authenticate successfully with valid credentials and allow logout', async ({ loginPage }) => {
    // I am submitting valid credentials to verify end-to-end authentication into the Secure Area.
    await loginPage.login('tomsmith', 'SuperSecretPassword!');
    await loginPage.expectLoginSuccess();

    // I am logging out of the Secure Area and verifying the user returns to the login view with confirmation feedback.
    await loginPage.logout();
    await expect(loginPage.pageHeading).toBeVisible();
    await expect(loginPage.documentRoot).toContainText('You logged out of the secure area!');
  });

  test('Negative: should reject login and display error banner when username is invalid', async ({ loginPage }) => {
    // I am providing an unrecognized username to verify the invalid username error boundary.
    await loginPage.login('invalid_user_account', 'SuperSecretPassword!');
    await loginPage.expectLoginError('Your username is invalid!');
  });

  test('Negative: should reject login and display error banner when password is invalid', async ({ loginPage }) => {
    // I am providing an incorrect password for a valid user to verify the password validation error boundary.
    await loginPage.login('tomsmith', 'IncorrectPassword123!');
    await loginPage.expectLoginError('Your password is invalid!');
  });

  test('Edge Case: should reject login when submitting empty username and password fields', async ({ loginPage }) => {
    // I am submitting empty strings for both credentials to verify boundary handling on blank form submission.
    await loginPage.login('', '');
    await loginPage.expectLoginError('Your username is invalid!');
  });
});
