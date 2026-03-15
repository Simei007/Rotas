import { TestBed } from '@angular/core/testing';
import { App } from './app';

// Mock para window.matchMedia sem dependência de jest
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Mock para MediaQueryList
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Mock para ViewChild e outras dependências
const mockElementRef = {
  nativeElement: document.createElement('div'),
};

// Mock para propriedades e métodos do componente
jest.mock('./app', () => {
  return {
    ...jest.requireActual('./app'),
    handleBeforeInstallPrompt: jest.fn(),
    handleAppInstalled: jest.fn(),
  };
});

// Mock para interações com o DOM e estado do navegador
Object.defineProperty(document, 'fullscreenElement', {
  writable: true,
  value: null,
});

Object.defineProperty(document, 'visibilityState', {
  writable: true,
  value: 'visible',
});

// Mock para speechSynthesis
Object.defineProperty(window, 'speechSynthesis', {
  writable: true,
  value: {
    speak: jest.fn(),
    cancel: jest.fn(),
  },
});

// Mock para window.location e eventos globais
Object.defineProperty(window, 'location', {
  writable: true,
  value: {
    hostname: 'localhost',
    isSecureContext: true,
  },
});

// Mock para document.addEventListener e document.removeEventListener
document.addEventListener = jest.fn();
document.removeEventListener = jest.fn();

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: ElementRef, useValue: mockElementRef },
      ],
    }).compileComponents();
  });

  // Garantir que o ambiente de teste seja isolado
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Gravador de Rotas em Tempo Real');
  });
});
