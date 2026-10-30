import { Page, Locator, expect } from '@playwright/test';

// I am encapsulating the Login Page interactions and semantic user-facing locators inside a dedicated Page Object Model.
export class LoginPage {
  readonly page: Page;
  readonly pageHeading: Locator;
  readonly secureAreaHeading: Locator;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;
  readonly logoutLink: Locator;
  readonly documentRoot: Locator;

  constructor(page: Page) {
    this.page = page;
    // I am selecting headings, inputs, and actions strictly via semantic getByRole and getByLabel locators to avoid brittle CSS or XPath selectors.
    this.pageHeading = page.getByRole('heading', { name: 'Login Page' });
    this.secureAreaHeading = page.getByRole('heading', { name: 'Secure Area', exact: true });
    this.usernameInput = page.getByLabel('Username');
    this.passwordInput = page.getByLabel('Password');
    this.loginButton = page.getByRole('button', { name: /login/i });
    this.logoutLink = page.getByRole('link', { name: /logout/i });
    // I am referencing the semantic document root role so status and error banners can be asserted without relying on CSS IDs or classes.
    this.documentRoot = page.getByRole('document');
  }

  // I am navigating to the target login URL and verifying that the primary Login Page heading is visible before interacting.
  async goto(): Promise<void> {
    // I am blocking non-essential static sub-resources so render-blocking scripts and stylesheets never stall DOM readiness.
    await this.page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet', 'script'].includes(resourceType)) {
        return route.abort();
      }
      return route.continue();
    });
    await this.page.goto('https://the-internet.herokuapp.com/login', { waitUntil: 'domcontentloaded' });
    await expect(this.pageHeading).toBeVisible();
  }

  // I am populating the username and password fields using label-bound locators and submitting the form via the semantic login button.
  async login(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  // I am clicking the semantic logout link to terminate the authenticated session.
  async logout(): Promise<void> {
    await expect(this.logoutLink).toBeVisible();
    await this.logoutLink.click();
  }

  // I am verifying successful authentication by asserting the Secure Area heading, logout action, and confirmation message visibility.
  async expectLoginSuccess(): Promise<void> {
    await expect(this.secureAreaHeading).toBeVisible();
    await expect(this.logoutLink).toBeVisible();
    await expect(this.documentRoot).toContainText('You logged into a secure area!');
  }

  // I am verifying error boundary visibility when invalid or empty credentials are submitted.
  async expectLoginError(expectedMessage: string): Promise<void> {
    await expect(this.pageHeading).toBeVisible();
    await expect(this.documentRoot).toContainText(expectedMessage);
  }
}
