# Rotas

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.1.4.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## PWA (install on PC and mobile)

The project is configured as a PWA (Web App Manifest + Service Worker).

1. Build for production:

```bash
npm run build
```

2. Publish the `dist/rotas/browser` folder on an HTTPS host.
Localhost is accepted for local tests, but installation on another device requires HTTPS.

3. Install:
- Windows/Chrome or Edge: open the app URL and click "Install app" in the address bar/menu.
- Android/Chrome: open the app URL, then use "Install app" or "Add to home screen".
- iPhone/Safari: open the app URL, tap Share, then "Add to Home Screen".

For local validation, serve the production build with a static server (instead of opening `index.html` directly).

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
