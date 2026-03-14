import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  signal
} from '@angular/core';
import * as L from 'leaflet';

interface RoutePoint {
  id: number;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  timestamp: number;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
}

type InstallPlatform = 'android' | 'ios' | 'desktop' | 'unknown';
type NavigationDirection = 'forward' | 'reverse';

interface PersistedRouteSession {
  points: RoutePoint[];
  startedAt: number | null;
  endedAt: number | null;
  pointSeq: number;
}

interface PersistedNamedRoute {
  id: string;
  name: string;
  points: RoutePoint[];
  startedAt: number | null;
  endedAt: number | null;
  pointSeq: number;
  savedAt: number;
}

interface SavedNamedRoute extends PersistedNamedRoute {
  distanceMeters: number;
}

interface NamedRouteExportFile {
  format: 'rotas.named-route.v1';
  exportedAt: number;
  route: PersistedNamedRoute;
}

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild('mapPanel') private mapPanel?: ElementRef<HTMLElement>;
  @ViewChild('mapContainer') private mapContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('routeImportInput') private routeImportInput?: ElementRef<HTMLInputElement>;

  protected readonly appTitle = 'Gravador de Rotas em Tempo Real';
  protected readonly hasGeolocation = typeof navigator !== 'undefined' && 'geolocation' in navigator;

  protected readonly isRecording = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly routePoints = signal<RoutePoint[]>([]);
  protected readonly canTriggerInstall = signal(false);
  protected readonly installStatusMessage = signal<string | null>(null);
  protected readonly isInstalled = signal(false);
  protected readonly installPlatform = signal<InstallPlatform>('unknown');
  protected readonly isMapNativeFullscreen = signal(false);
  protected readonly isMapFullscreenFallback = signal(false);
  protected readonly isMapExpanded = computed(
    () => this.isMapNativeFullscreen() || this.isMapFullscreenFallback()
  );
  protected readonly followCurrentLocation = signal(true);
  protected readonly isReviewing = signal(false);
  protected readonly reviewPointIndex = signal(0);
  protected readonly isNavigating = signal(false);
  protected readonly navigationDirection = signal<NavigationDirection>('forward');
  protected readonly navigationPointIndex = signal(0);
  protected readonly navigationStatusMessage = signal<string | null>(null);
  protected readonly wakeLockMessage = signal<string | null>(null);
  protected readonly voiceGuidanceEnabled = signal(true);
  protected readonly isHistoryOpen = signal(false);
  protected readonly routeNameDraft = signal('');
  protected readonly savedRoutes = signal<SavedNamedRoute[]>([]);
  protected readonly canSaveNamedRoute = computed(
    () =>
      this.routePoints().length > 0 &&
      this.routeNameDraft().trim().length > 0 &&
      !this.isRecording() &&
      !this.isNavigating()
  );

  private readonly startedAt = signal<number | null>(null);
  private readonly endedAt = signal<number | null>(null);
  private readonly now = signal(Date.now());

  private watchId: number | null = null;
  private navigationWatchId: number | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private reviewTimerId: ReturnType<typeof setInterval> | null = null;
  private pointSeq = 0;
  private map: L.Map | null = null;
  private routeLine: L.Polyline | null = null;
  private liveMarker: L.CircleMarker | null = null;
  private hasCenteredOnRoute = false;
  private readonly initialCenter: L.LatLngTuple = [-23.55052, -46.633308];
  private readonly followZoomLevel = 18;
  private readonly reviewTickMs = 700;
  private readonly navigationArrivalThresholdMeters = 20;
  private readonly storageKey = 'rotas.route-session.v1';
  private readonly namedRoutesStorageKey = 'rotas.named-routes.v1';
  private readonly namedRouteExportFormat = 'rotas.named-route.v1';
  private readonly maxSavedRoutes = 40;
  private deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
  private displayModeQuery: MediaQueryList | null = null;
  private wakeLockSentinel: WakeLockSentinelLike | null = null;
  private navigationInitialized = false;

  private readonly handleBeforeInstallPrompt = (event: Event): void => {
    const promptEvent = event as BeforeInstallPromptEvent;
    promptEvent.preventDefault();
    this.deferredInstallPrompt = promptEvent;
    this.canTriggerInstall.set(true);
    this.installStatusMessage.set(null);
  };

  private readonly handleAppInstalled = (): void => {
    this.isInstalled.set(true);
    this.canTriggerInstall.set(false);
    this.deferredInstallPrompt = null;
    this.installStatusMessage.set('Aplicativo instalado neste dispositivo.');
  };

  private readonly handleDisplayModeChange = (_event?: MediaQueryListEvent): void => {
    this.updateInstallState();
  };

  private readonly handleFullscreenChange = (): void => {
    if (typeof document === 'undefined') {
      return;
    }

    const panel = this.mapPanel?.nativeElement;
    const isPanelFullscreen = Boolean(panel) && document.fullscreenElement === panel;
    this.isMapNativeFullscreen.set(isPanelFullscreen);

    if (isPanelFullscreen) {
      this.isMapFullscreenFallback.set(false);
    }

    this.updateBodyScrollLockState();
    this.scheduleMapResize();
  };

  private readonly handleVisibilityChange = (): void => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') {
      return;
    }

    if (this.isRecording() || this.isNavigating()) {
      void this.requestWakeLock();
    }
  };

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.isHistoryOpen()) {
      this.closeHistory();
    }
  };

  protected readonly pointCount = computed(() => this.routePoints().length);

  protected readonly totalDistanceMeters = computed(() => {
    const points = this.routePoints();
    if (points.length < 2) {
      return 0;
    }

    let distance = 0;
    for (let i = 1; i < points.length; i += 1) {
      distance += this.haversineMeters(points[i - 1], points[i]);
    }
    return distance;
  });

  protected readonly elapsedMs = computed(() => {
    const start = this.startedAt();
    if (!start) {
      return 0;
    }

    const end = this.isRecording() ? this.now() : (this.endedAt() ?? this.now());
    return Math.max(0, end - start);
  });

  protected readonly recentPoints = computed(() => this.routePoints().slice(-10).reverse());
  protected readonly historyPoints = computed(() => [...this.routePoints()].reverse());
  protected readonly canReviewRoute = computed(
    () => this.routePoints().length > 1 && !this.isRecording() && !this.isReviewing()
  );
  protected readonly canNavigateRoute = computed(
    () =>
      this.routePoints().length > 1 &&
      !this.isRecording() &&
      !this.isReviewing() &&
      !this.isNavigating() &&
      this.hasGeolocation
  );
  protected readonly reviewProgressMessage = computed(() => {
    if (!this.isReviewing()) {
      return null;
    }

    const total = this.routePoints().length;
    const current = Math.min(this.reviewPointIndex() + 1, total);
    return `Revisando ponto ${current} de ${total}.`;
  });
  protected readonly navigationProgressMessage = computed(() => {
    if (!this.isNavigating()) {
      return null;
    }

    const total = this.routePoints().length;
    const current = Math.min(this.navigationPointIndex() + 1, total);
    const direction = this.navigationDirection() === 'forward' ? 'ida' : 'volta';
    return `Navegacao ${direction}: ponto ${current} de ${total}.`;
  });
  protected readonly supportsVoiceGuidance = computed(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window
  );
  protected readonly installHelpMessage = computed(() => {
    if (this.isInstalled()) {
      return 'Aplicativo ja instalado neste dispositivo.';
    }

    if (this.canTriggerInstall()) {
      return 'Clique em "Instalar app" para adicionar no PC ou celular.';
    }

    switch (this.installPlatform()) {
      case 'ios':
        return 'No Safari do iPhone: Compartilhar > Adicionar a Tela de Inicio.';
      case 'android':
        return 'No Chrome do Android: menu > Instalar app ou Adicionar a tela inicial.';
      case 'desktop':
        return 'No Chrome/Edge: menu do navegador > Instalar app.';
      default:
        return 'Use o menu do navegador para instalar este app.';
    }
  });

  protected readonly installContextWarning = computed(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    if (window.isSecureContext || window.location.hostname === 'localhost') {
      return null;
    }

    return 'A instalacao requer HTTPS ou localhost.';
  });

  ngOnInit(): void {
    this.restoreNamedRoutes();
    this.restorePersistedSession();
    this.updateInstallState();
    this.installPlatform.set(this.detectInstallPlatform());

    if (typeof window === 'undefined') {
      return;
    }

    window.addEventListener('beforeinstallprompt', this.handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', this.handleAppInstalled);
    this.displayModeQuery = window.matchMedia('(display-mode: standalone)');
    try {
      this.displayModeQuery.addEventListener('change', this.handleDisplayModeChange);
    } catch {
      const legacyQuery = this.displayModeQuery as MediaQueryList & {
        addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      };
      legacyQuery.addListener?.(this.handleDisplayModeChange);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('fullscreenchange', this.handleFullscreenChange);
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
      document.addEventListener('keydown', this.handleGlobalKeydown);
    }
  }

  ngAfterViewInit(): void {
    this.initializeMap();
    this.hydrateMapFromStoredRoute();
  }

  ngOnDestroy(): void {
    this.stopReviewPlayback(false);
    this.stopNavigation(false);
    this.stopLocationTracking();
    void this.releaseWakeLock();
    this.cancelSpeech();
    this.destroyMap();
    this.setBodyScrollLock(false);

    if (typeof document !== 'undefined' && this.mapPanel?.nativeElement === document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeinstallprompt', this.handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', this.handleAppInstalled);
      if (this.displayModeQuery) {
        try {
          this.displayModeQuery.removeEventListener('change', this.handleDisplayModeChange);
        } catch {
          const legacyQuery = this.displayModeQuery as MediaQueryList & {
            removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
          };
          legacyQuery.removeListener?.(this.handleDisplayModeChange);
        }
      }

      if (typeof document !== 'undefined') {
        document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        document.removeEventListener('keydown', this.handleGlobalKeydown);
      }
    }
  }

  protected async installApp(): Promise<void> {
    if (this.isInstalled()) {
      this.installStatusMessage.set('Aplicativo ja instalado neste dispositivo.');
      return;
    }

    if (!this.deferredInstallPrompt) {
      this.installStatusMessage.set(
        'Instalacao automatica indisponivel nesta sessao. Use o menu do navegador.'
      );
      return;
    }

    const promptEvent = this.deferredInstallPrompt;
    this.deferredInstallPrompt = null;
    this.canTriggerInstall.set(false);

    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === 'accepted') {
        this.installStatusMessage.set('Instalacao iniciada pelo navegador.');
      } else {
        this.installStatusMessage.set('Instalacao cancelada. Voce pode tentar novamente.');
      }
    } catch {
      this.installStatusMessage.set('Nao foi possivel abrir o instalador. Use o menu do navegador.');
    }
  }

  protected openHistory(): void {
    this.isHistoryOpen.set(true);
    this.updateBodyScrollLockState();
  }

  protected closeHistory(): void {
    this.isHistoryOpen.set(false);
    this.updateBodyScrollLockState();
  }

  protected updateRouteNameDraftFromEvent(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.routeNameDraft.set(target?.value ?? '');
  }

  protected saveNamedRoute(): void {
    if (!this.canSaveNamedRoute()) {
      return;
    }

    const routeName = this.routeNameDraft().trim();
    if (routeName.length === 0) {
      this.errorMessage.set('Digite um nome para salvar o trajeto.');
      return;
    }

    const points = this.cloneRoutePoints(this.routePoints());
    if (points.length === 0) {
      return;
    }

    const now = Date.now();
    const savedRoute: SavedNamedRoute = {
      id: this.createRouteId(),
      name: routeName,
      points,
      startedAt: this.startedAt(),
      endedAt: this.endedAt(),
      pointSeq: Math.max(this.pointSeq, points.length),
      savedAt: now,
      distanceMeters: this.calculateRouteDistance(points)
    };

    this.savedRoutes.update((routes) => [savedRoute, ...routes].slice(0, this.maxSavedRoutes));
    this.persistNamedRoutes();
    this.routeNameDraft.set('');
    this.errorMessage.set(null);
    this.navigationStatusMessage.set(`Trajeto "${routeName}" salvo no historico local.`);
  }

  protected loadNamedRoute(routeId: string): void {
    if (this.isRecording()) {
      this.errorMessage.set('Pare a gravacao antes de carregar um trajeto salvo.');
      return;
    }

    const route = this.savedRoutes().find((item) => item.id === routeId);
    if (!route) {
      return;
    }

    this.stopReviewPlayback(false);
    this.stopNavigation(false);
    this.cancelSpeech();

    const restoredPoints = this.cloneRoutePoints(route.points);
    this.routePoints.set(restoredPoints);
    this.pointSeq =
      typeof route.pointSeq === 'number' && route.pointSeq >= restoredPoints.length
        ? route.pointSeq
        : restoredPoints.length;
    this.reviewPointIndex.set(0);
    this.navigationPointIndex.set(0);
    this.startedAt.set(route.startedAt);
    this.endedAt.set(route.startedAt !== null && route.endedAt === null ? Date.now() : route.endedAt);
    this.now.set(Date.now());
    this.errorMessage.set(null);
    this.navigationStatusMessage.set(`Trajeto "${route.name}" carregado.`);
    this.resetMapRoute();
    this.hydrateMapFromStoredRoute();
    this.persistSession();
    this.closeHistory();
  }

  protected deleteNamedRoute(routeId: string): void {
    const current = this.savedRoutes();
    const next = current.filter((route) => route.id !== routeId);

    if (next.length === current.length) {
      return;
    }

    this.savedRoutes.set(next);
    if (next.length === 0) {
      this.clearNamedRoutesStorage();
    } else {
      this.persistNamedRoutes();
    }
    this.navigationStatusMessage.set('Trajeto removido do historico salvo.');
  }

  protected async shareNamedRoute(routeId: string): Promise<void> {
    const route = this.savedRoutes().find((item) => item.id === routeId);
    if (!route) {
      return;
    }

    const exportFile = this.createNamedRouteExportFile(route);
    const shareNavigator = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
      canShare?: (data?: ShareData) => boolean;
    };

    const shareData: ShareData = {
      title: `Trajeto ${route.name}`,
      text: `Trajeto ${route.name} para importar no app Rotas.`,
      files: [exportFile]
    };

    const supportsFileShare =
      typeof shareNavigator.share === 'function' &&
      (typeof shareNavigator.canShare !== 'function' ||
        shareNavigator.canShare({ files: [exportFile] }));

    if (supportsFileShare) {
      try {
        await shareNavigator.share(shareData);
        this.errorMessage.set(null);
        this.navigationStatusMessage.set(`Trajeto "${route.name}" compartilhado.`);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
      }
    }

    this.downloadNamedRouteFile(exportFile);
    this.errorMessage.set(null);
    this.navigationStatusMessage.set(
      'Compartilhamento indisponivel neste navegador. Arquivo baixado para enviar no WhatsApp.'
    );
  }

  protected triggerRouteImport(): void {
    if (this.isRecording() || this.isNavigating()) {
      this.errorMessage.set('Pare a gravacao ou a navegacao antes de importar um trajeto.');
      return;
    }

    const input = this.routeImportInput?.nativeElement;
    if (!input) {
      return;
    }

    input.value = '';
    input.click();
  }

  protected async importNamedRouteFromFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      return;
    }

    try {
      const rawText = await file.text();
      const importedRoute = this.parseImportedNamedRoute(rawText);
      if (!importedRoute) {
        this.errorMessage.set(
          'Arquivo invalido. Envie um arquivo JSON exportado pelo app Rotas.'
        );
        return;
      }

      const importedName = this.createUniqueRouteName(importedRoute.name);
      const pointSeq =
        typeof importedRoute.pointSeq === 'number' && importedRoute.pointSeq >= importedRoute.points.length
          ? importedRoute.pointSeq
          : importedRoute.points.length;

      const routeToSave: SavedNamedRoute = {
        id: this.createRouteId(),
        name: importedName,
        points: this.cloneRoutePoints(importedRoute.points),
        startedAt: importedRoute.startedAt,
        endedAt: importedRoute.endedAt,
        pointSeq,
        savedAt: Date.now(),
        distanceMeters: this.calculateRouteDistance(importedRoute.points)
      };

      this.savedRoutes.update((routes) => [routeToSave, ...routes].slice(0, this.maxSavedRoutes));
      this.persistNamedRoutes();
      this.errorMessage.set(null);
      this.navigationStatusMessage.set(`Trajeto "${importedName}" importado e salvo.`);
    } catch {
      this.errorMessage.set('Nao foi possivel ler o arquivo selecionado.');
    } finally {
      if (input) {
        input.value = '';
      }
    }
  }

  protected async toggleMapExpanded(): Promise<void> {
    if (typeof document === 'undefined') {
      return;
    }

    if (this.isHistoryOpen()) {
      this.closeHistory();
    }

    const panel = this.mapPanel?.nativeElement;
    if (!panel) {
      return;
    }

    const supportsFullscreen =
      typeof panel.requestFullscreen === 'function' && typeof document.exitFullscreen === 'function';

    if (supportsFullscreen) {
      try {
        if (document.fullscreenElement === panel) {
          await document.exitFullscreen();
          return;
        }

        if (document.fullscreenElement && document.fullscreenElement !== panel) {
          await document.exitFullscreen();
        }

        await panel.requestFullscreen();
        return;
      } catch {
        // If fullscreen API is blocked, use fallback mode.
      }
    }

    const nextFallbackValue = !this.isMapFullscreenFallback();
    this.isMapFullscreenFallback.set(nextFallbackValue);
    this.updateBodyScrollLockState();
    this.scheduleMapResize();
  }

  protected toggleFollowCurrentLocation(): void {
    const nextValue = !this.followCurrentLocation();
    this.followCurrentLocation.set(nextValue);

    if (nextValue) {
      this.centerOnCurrentLocation();
    }
  }

  protected centerOnCurrentLocation(): void {
    const currentPoint = this.getCurrentMapFocusPoint();
    if (currentPoint) {
      this.focusMapOnPoint(currentPoint, this.followZoomLevel);
      return;
    }

    if (!this.hasGeolocation || !this.map) {
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latLng: L.LatLngTuple = [position.coords.latitude, position.coords.longitude];
        this.map?.setView(latLng, this.followZoomLevel, { animate: true });
      },
      () => {
        this.errorMessage.set('Nao foi possivel centralizar na localizacao atual.');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 12000
      }
    );
  }

  protected startReview(): void {
    if (!this.canReviewRoute()) {
      return;
    }

    this.stopReviewPlayback(false);
    this.isReviewing.set(true);
    this.reviewPointIndex.set(0);

    const points = this.routePoints();
    const firstPoint = points[0];
    this.updateLiveMarker(firstPoint);

    if (this.followCurrentLocation()) {
      this.focusMapOnPoint(firstPoint, this.followZoomLevel);
    }

    this.reviewTimerId = setInterval(() => {
      const route = this.routePoints();
      const nextIndex = this.reviewPointIndex() + 1;

      if (nextIndex >= route.length) {
        this.stopReviewPlayback(true);
        return;
      }

      this.reviewPointIndex.set(nextIndex);
      const point = route[nextIndex];
      this.updateLiveMarker(point);

      if (this.followCurrentLocation()) {
        this.focusMapOnPoint(point, this.followZoomLevel);
      }
    }, this.reviewTickMs);
  }

  protected stopReview(): void {
    this.stopReviewPlayback(false);
  }

  protected startNavigation(direction: NavigationDirection): void {
    if (!this.canNavigateRoute()) {
      return;
    }

    this.stopReviewPlayback(false);
    this.stopNavigation(false);
    this.navigationDirection.set(direction);
    this.navigationPointIndex.set(0);
    this.navigationStatusMessage.set('Navegacao iniciada. Aguarde sinal de localizacao.');
    this.isNavigating.set(true);
    this.navigationInitialized = false;

    // Ajusta a orientação do mapa com base na direção
    this.adjustMapOrientation(direction);

    // Ajusta a fala para evitar interrupções
    this.speakMessage(`Navegação ${direction === 'forward' ? 'de ida' : 'de volta'} iniciada.`);
    void this.requestWakeLock();

    try {
      this.navigationWatchId = navigator.geolocation.watchPosition(
        (position) => this.handleNavigationPosition(position),
        (error) => this.handlePositionError(error),
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 15000
        }
      );
    } catch {
      this.navigationStatusMessage.set('Não foi possível iniciar a navegação neste dispositivo.');
      this.stopNavigation(false);
    }
  }

  private adjustMapOrientation(direction: NavigationDirection): void {
    const mapElement = this.mapPanel?.nativeElement;
    if (mapElement) {
      const rotationAngle = direction === 'forward' ? 0 : 180;
      mapElement.style.transform = `rotate(${rotationAngle}deg)`;
      console.log(`Rotação aplicada: ${rotationAngle} graus`);
    } else {
      console.warn('Elemento mapPanel não encontrado.');
    }
  }

  protected stopNavigation(notify: boolean = true): void {
    if (this.navigationWatchId !== null && this.hasGeolocation) {
      navigator.geolocation.clearWatch(this.navigationWatchId);
      this.navigationWatchId = null;
    }

    if (!this.isNavigating()) {
      void this.syncWakeLockState();
      return;
    }

    this.isNavigating.set(false);
    this.navigationInitialized = false;

    if (notify) {
      this.navigationStatusMessage.set('Navegacao encerrada.');
      this.speakMessage('Navegacao encerrada.');
    }

    void this.syncWakeLockState();
  }

  protected toggleVoiceGuidance(): void {
    const next = !this.voiceGuidanceEnabled();
    this.voiceGuidanceEnabled.set(next);

    if (!next) {
      this.cancelSpeech();
    }
  }

  protected startRecording(): void {
    if (!this.hasGeolocation || this.isRecording()) {
      return;
    }

    this.stopReviewPlayback(false);
    this.stopNavigation(false);
    this.cancelSpeech();

    this.errorMessage.set(null);
    this.navigationStatusMessage.set(null);
    this.routePoints.set([]);
    this.pointSeq = 0;
    this.reviewPointIndex.set(0);
    this.hasCenteredOnRoute = false;
    this.resetMapRoute();

    const started = Date.now();
    this.startedAt.set(started);
    this.endedAt.set(null);
    this.now.set(started);
    this.isRecording.set(true);
    this.startTimer();
    this.persistSession();
    void this.requestWakeLock();

    try {
      this.watchId = navigator.geolocation.watchPosition(
        (position) => this.handlePosition(position),
        (error) => this.handlePositionError(error),
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 15000
        }
      );
    } catch (error) {
      this.errorMessage.set('Nao foi possivel iniciar a geolocalizacao neste dispositivo.');
      this.stopRecording();
    }
  }

  protected stopRecording(): void {
    if (!this.isRecording()) {
      return;
    }

    this.stopLocationTracking();
    this.endedAt.set(Date.now());
    this.isRecording.set(false);
    this.persistSession();
    void this.syncWakeLockState();
  }

  protected clearRoute(): void {
    if (this.isRecording()) {
      return;
    }

    this.stopReviewPlayback(false);
    this.stopNavigation(false);
    this.cancelSpeech();
    this.routePoints.set([]);
    this.reviewPointIndex.set(0);
    this.navigationPointIndex.set(0);
    this.startedAt.set(null);
    this.endedAt.set(null);
    this.now.set(Date.now());
    this.errorMessage.set(null);
    this.navigationStatusMessage.set(null);
    this.resetMapRoute();
    this.clearPersistedSession();
    void this.syncWakeLockState();
  }

  protected formatCoordinate(value: number): string {
    return value.toFixed(6);
  }

  protected formatDistance(meters: number): string {
    if (meters < 1000) {
      return `${meters.toFixed(0)} m`;
    }

    return `${(meters / 1000).toFixed(2)} km`;
  }

  protected formatDuration(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');

    return `${hh}:${mm}:${ss}`;
  }

  protected formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  protected formatDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  private startTimer(): void {
    this.stopTimer();

    this.timerId = setInterval(() => {
      this.now.set(Date.now());
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private stopLocationTracking(): void {
    if (this.watchId !== null && this.hasGeolocation) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.stopTimer();
  }

  private handlePosition(position: GeolocationPosition): void {
    this.pointSeq += 1;

    const speed = position.coords.speed;

    const point: RoutePoint = {
      id: this.pointSeq,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      speed: typeof speed === 'number' && !Number.isNaN(speed) ? speed : null,
      timestamp: position.timestamp
    };

    this.routePoints.update((points) => [...points, point]);
    this.errorMessage.set(null);
    this.updateMapRoute(point);
    this.persistSession();
  }

  private handleNavigationPosition(position: GeolocationPosition): void {
    const navigationPath = this.getNavigationPath();
    if (navigationPath.length < 2) {
      this.navigationStatusMessage.set('Rota insuficiente para navegacao.');
      this.stopNavigation(false);
      return;
    }

    const currentPoint: RoutePoint = {
      id: 0,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      speed:
        typeof position.coords.speed === 'number' && !Number.isNaN(position.coords.speed)
          ? position.coords.speed
          : null,
      timestamp: position.timestamp
    };

    this.updateLiveMarker(currentPoint);
    if (this.followCurrentLocation()) {
      this.focusMapOnPoint(currentPoint, this.followZoomLevel);
    }

    if (!this.navigationInitialized) {
      const closestIndex = this.findClosestPointIndex(navigationPath, currentPoint);
      this.navigationPointIndex.set(closestIndex);
      this.navigationInitialized = true;
      this.navigationStatusMessage.set(
        `Navegacao ativa. Iniciando do ponto ${closestIndex + 1} de ${navigationPath.length}.`
      );
      this.speakMessage(this.createNavigationInstruction(navigationPath, closestIndex));
      return;
    }

    const currentIndex = Math.min(this.navigationPointIndex(), navigationPath.length - 1);
    const targetPoint = navigationPath[currentIndex];
    const distanceToTarget = this.haversineMeters(currentPoint, targetPoint);

    if (distanceToTarget > this.navigationArrivalThresholdMeters) {
      return;
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex >= navigationPath.length) {
      this.navigationStatusMessage.set('Trajeto concluido.');
      this.speakMessage('Trajeto concluido.');
      this.stopNavigation(false);
      return;
    }

    this.navigationPointIndex.set(nextIndex);
    const instruction = this.createNavigationInstruction(navigationPath, nextIndex);
    this.navigationStatusMessage.set(instruction);
    this.speakMessage(instruction);
  }

  private handlePositionError(error: GeolocationPositionError): void {
    const setMessages = (message: string): void => {
      this.errorMessage.set(message);
      if (this.isNavigating()) {
        this.navigationStatusMessage.set(message);
      }
    };

    switch (error.code) {
      case error.PERMISSION_DENIED:
        setMessages('Permissao de localizacao negada. Ative a permissao para gravar rotas.');
        break;
      case error.POSITION_UNAVAILABLE:
        setMessages('Localizacao indisponivel no momento. Tente novamente em uma area aberta.');
        break;
      case error.TIMEOUT:
        setMessages('Tempo limite excedido ao buscar localizacao.');
        break;
      default:
        setMessages('Erro inesperado ao capturar localizacao.');
        break;
    }
  }

  private haversineMeters(first: RoutePoint, second: RoutePoint): number {
    const earthRadius = 6_371_000;
    const lat1 = this.toRadians(first.latitude);
    const lat2 = this.toRadians(second.latitude);
    const deltaLat = this.toRadians(second.latitude - first.latitude);
    const deltaLng = this.toRadians(second.longitude - first.longitude);

    const a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadius * c;
  }

  private toRadians(value: number): number {
    return (value * Math.PI) / 180;
  }

  private calculateBearing(from: RoutePoint, to: RoutePoint): number {
    const fromLat = this.toRadians(from.latitude);
    const toLat = this.toRadians(to.latitude);
    const deltaLng = this.toRadians(to.longitude - from.longitude);

    const y = Math.sin(deltaLng) * Math.cos(toLat);
    const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);
    const angle = (Math.atan2(y, x) * 180) / Math.PI;
    return (angle + 360) % 360;
  }

  private normalizeBearingDelta(nextBearing: number, previousBearing: number): number {
    return ((nextBearing - previousBearing + 540) % 360) - 180;
  }

  private getNavigationPath(): RoutePoint[] {
    const points = this.routePoints();
    if (this.navigationDirection() === 'reverse') {
      return [...points].reverse();
    }

    return points;
  }

  private findClosestPointIndex(path: RoutePoint[], reference: RoutePoint): number {
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < path.length; i += 1) {
      const distance = this.haversineMeters(reference, path[i]);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = i;
      }
    }

    return closestIndex;
  }

  private createNavigationInstruction(path: RoutePoint[], currentIndex: number): string {
    if (currentIndex >= path.length - 1) {
      return 'Voce esta no ponto final do trajeto.';
    }

    const current = path[currentIndex];
    const next = path[currentIndex + 1];
    const distanceToNext = this.formatDistance(this.haversineMeters(current, next));

    if (currentIndex === 0) {
      return `Siga em frente por ${distanceToNext}.`;
    }

    const previous = path[currentIndex - 1];
    const previousBearing = this.calculateBearing(previous, current);
    const nextBearing = this.calculateBearing(current, next);
    const angle = this.normalizeBearingDelta(nextBearing, previousBearing);

    if (Math.abs(angle) < 20) {
      return `Continue em frente por ${distanceToNext}.`;
    }

    if (Math.abs(angle) > 130) {
      return `Retorne quando possivel e siga por ${distanceToNext}.`;
    }

    if (angle > 0) {
      return `Vire a direita e siga por ${distanceToNext}.`;
    }

    return `Vire a esquerda e siga por ${distanceToNext}.`;
  }

  private speakMessage(message: string): void {
    if (!this.voiceGuidanceEnabled() || !this.supportsVoiceGuidance()) {
      return;
    }

    this.cancelSpeech();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = 'pt-BR';
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  }

  private cancelSpeech(): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

    window.speechSynthesis.cancel();
  }

  private initializeMap(): void {
    if (!this.mapContainer || this.map) {
      return;
    }

    this.map = L.map(this.mapContainer.nativeElement, {
      zoomControl: true
    }).setView(this.initialCenter, 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(this.map);

    this.routeLine = L.polyline([], {
      color: '#0f8bda',
      weight: 5,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(this.map);

    this.scheduleMapResize();
  }

  private updateMapRoute(point: RoutePoint): void {
    if (!this.map || !this.routeLine) {
      return;
    }

    const latLng = this.toLatLng(point);
    this.routeLine.addLatLng(latLng);
    this.updateLiveMarker(point);

    if (!this.hasCenteredOnRoute) {
      this.focusMapOnPoint(point, this.followZoomLevel);
      this.hasCenteredOnRoute = true;
      return;
    }

    if (this.followCurrentLocation()) {
      this.focusMapOnPoint(point, this.followZoomLevel);
    }
  }

  private resetMapRoute(): void {
    if (!this.map || !this.routeLine) {
      return;
    }

    this.hasCenteredOnRoute = false;
    this.routeLine.setLatLngs([]);

    if (this.liveMarker) {
      this.liveMarker.removeFrom(this.map);
      this.liveMarker = null;
    }

    this.map.setView(this.initialCenter, 13);
  }

  private stopReviewPlayback(keepLastPointOnMap: boolean): void {
    if (this.reviewTimerId !== null) {
      clearInterval(this.reviewTimerId);
      this.reviewTimerId = null;
    }

    if (!this.isReviewing()) {
      return;
    }

    this.isReviewing.set(false);

    const points = this.routePoints();
    if (!keepLastPointOnMap || points.length === 0) {
      return;
    }

    const lastPoint = points[points.length - 1];
    this.reviewPointIndex.set(points.length - 1);
    this.updateLiveMarker(lastPoint);
  }

  private updateLiveMarker(point: RoutePoint): void {
    if (!this.map) {
      return;
    }

    const latLng = this.toLatLng(point);

    if (!this.liveMarker) {
      this.liveMarker = L.circleMarker(latLng, {
        radius: 8,
        color: '#ffffff',
        weight: 2,
        fillColor: '#e44545',
        fillOpacity: 1
      }).addTo(this.map);
    } else {
      this.liveMarker.setLatLng(latLng);
    }
  }

  private getCurrentMapFocusPoint(): RoutePoint | null {
    const points = this.routePoints();
    if (points.length === 0) {
      return null;
    }

    if (this.isReviewing()) {
      const index = Math.min(this.reviewPointIndex(), points.length - 1);
      return points[index];
    }

    return points[points.length - 1];
  }

  private focusMapOnPoint(point: RoutePoint, zoom: number): void {
    if (!this.map) {
      return;
    }

    this.map.setView(this.toLatLng(point), zoom, { animate: true });
  }

  private toLatLng(point: RoutePoint): L.LatLngTuple {
    return [point.latitude, point.longitude];
  }

  private destroyMap(): void {
    if (this.map) {
      this.map.remove();
      this.map = null;
      this.routeLine = null;
      this.liveMarker = null;
    }
  }

  private setBodyScrollLock(shouldLock: boolean): void {
    if (typeof document === 'undefined') {
      return;
    }

    document.body.style.overflow = shouldLock ? 'hidden' : '';
  }

  private updateBodyScrollLockState(): void {
    this.setBodyScrollLock(this.isMapFullscreenFallback() || this.isHistoryOpen());
  }

  private scheduleMapResize(): void {
    setTimeout(() => this.map?.invalidateSize(), 80);
    setTimeout(() => this.map?.invalidateSize(), 240);
  }

  private async requestWakeLock(): Promise<void> {
    if (typeof navigator === 'undefined') {
      return;
    }

    const wakeLockNavigator = navigator as Navigator & {
      wakeLock?: {
        request(type: 'screen'): Promise<WakeLockSentinelLike>;
      };
    };

    if (!wakeLockNavigator.wakeLock) {
      this.wakeLockMessage.set(
        'Seu navegador pode pausar a gravacao com a tela desligada. Mantenha a tela ativa.'
      );
      return;
    }

    if (this.wakeLockSentinel && !this.wakeLockSentinel.released) {
      return;
    }

    try {
      this.wakeLockSentinel = await wakeLockNavigator.wakeLock.request('screen');
      this.wakeLockSentinel.addEventListener?.('release', () => {
        this.wakeLockSentinel = null;
      });
      this.wakeLockMessage.set(null);
    } catch {
      this.wakeLockMessage.set(
        'Nao foi possivel manter a tela ativa automaticamente. Evite bloquear a tela.'
      );
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (!this.wakeLockSentinel) {
      return;
    }

    try {
      await this.wakeLockSentinel.release();
    } catch {
      // Ignore release failures.
    } finally {
      this.wakeLockSentinel = null;
    }
  }

  private async syncWakeLockState(): Promise<void> {
    if (this.isRecording() || this.isNavigating()) {
      await this.requestWakeLock();
      return;
    }

    await this.releaseWakeLock();
  }

  private createRouteId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return `route-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  }

  private cloneRoutePoints(points: RoutePoint[]): RoutePoint[] {
    return points.map((point) => ({ ...point }));
  }

  private createNamedRouteExportPayload(route: SavedNamedRoute): NamedRouteExportFile {
    return {
      format: this.namedRouteExportFormat,
      exportedAt: Date.now(),
      route: this.toPersistedNamedRoute(route)
    };
  }

  private createNamedRouteExportFile(route: SavedNamedRoute): File {
    const payload = this.createNamedRouteExportPayload(route);
    const routeNamePart = this.normalizeRouteNameForFile(route.name);
    const fileName = `trajeto-${routeNamePart}.json`;
    return new File([JSON.stringify(payload, null, 2)], fileName, {
      type: 'application/json'
    });
  }

  private parseImportedNamedRoute(rawText: string): PersistedNamedRoute | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      return null;
    }

    let candidate: unknown = parsed;
    if (parsed && typeof parsed === 'object') {
      const exportedPayload = parsed as Partial<NamedRouteExportFile> & { route?: unknown };
      if (exportedPayload.format === this.namedRouteExportFormat && exportedPayload.route) {
        candidate = exportedPayload.route;
      }
    }

    const parsedRoute = this.parseNamedRoute(candidate);
    if (!parsedRoute) {
      return null;
    }

    return this.toPersistedNamedRoute(parsedRoute);
  }

  private createUniqueRouteName(baseName: string): string {
    const sanitized = baseName.trim().slice(0, 60);
    const initialName = sanitized.length > 0 ? sanitized : `Trajeto ${this.formatDateTime(Date.now())}`;
    const existingNames = new Set(this.savedRoutes().map((route) => route.name.toLocaleLowerCase('pt-BR')));

    if (!existingNames.has(initialName.toLocaleLowerCase('pt-BR'))) {
      return initialName;
    }

    let suffix = 2;
    while (true) {
      const candidate = `${initialName} (${suffix})`;
      if (!existingNames.has(candidate.toLocaleLowerCase('pt-BR'))) {
        return candidate;
      }
      suffix += 1;
    }
  }

  private normalizeRouteNameForFile(routeName: string): string {
    const normalized = routeName
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();

    return normalized.length > 0 ? normalized : 'rotas';
  }

  private downloadNamedRouteFile(file: File): void {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = file.name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }

  private sanitizeRoutePoints(points: unknown): RoutePoint[] {
    if (!Array.isArray(points)) {
      return [];
    }

    return points
      .filter((point) => {
        const candidate = point as Partial<RoutePoint>;
        return (
          Number.isFinite(candidate.latitude) &&
          Number.isFinite(candidate.longitude) &&
          Number.isFinite(candidate.timestamp)
        );
      })
      .map((point, index) => {
        const candidate = point as Partial<RoutePoint>;
        const speed = candidate.speed;
        return {
          id: typeof candidate.id === 'number' ? candidate.id : index + 1,
          latitude: Number(candidate.latitude),
          longitude: Number(candidate.longitude),
          accuracy: Number.isFinite(candidate.accuracy) ? Number(candidate.accuracy) : 0,
          speed: typeof speed === 'number' && !Number.isNaN(speed) ? speed : null,
          timestamp: Number(candidate.timestamp)
        };
      });
  }

  private calculateRouteDistance(points: RoutePoint[]): number {
    if (points.length < 2) {
      return 0;
    }

    let totalDistance = 0;
    for (let i = 1; i < points.length; i += 1) {
      totalDistance += this.haversineMeters(points[i - 1], points[i]);
    }
    return totalDistance;
  }

  private toPersistedNamedRoute(route: SavedNamedRoute): PersistedNamedRoute {
    return {
      id: route.id,
      name: route.name,
      points: this.cloneRoutePoints(route.points),
      startedAt: route.startedAt,
      endedAt: route.endedAt,
      pointSeq: route.pointSeq,
      savedAt: route.savedAt
    };
  }

  private parseNamedRoute(candidate: unknown): SavedNamedRoute | null {
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const value = candidate as Partial<PersistedNamedRoute>;
    if (typeof value.id !== 'string' || typeof value.name !== 'string') {
      return null;
    }

    const name = value.name.trim();
    if (name.length === 0) {
      return null;
    }

    const points = this.sanitizeRoutePoints(value.points);
    if (points.length === 0) {
      return null;
    }

    const pointSeq =
      typeof value.pointSeq === 'number' && value.pointSeq >= points.length
        ? value.pointSeq
        : points.length;

    return {
      id: value.id,
      name,
      points,
      startedAt: typeof value.startedAt === 'number' ? value.startedAt : null,
      endedAt: typeof value.endedAt === 'number' ? value.endedAt : null,
      pointSeq,
      savedAt: typeof value.savedAt === 'number' ? value.savedAt : Date.now(),
      distanceMeters: this.calculateRouteDistance(points)
    };
  }

  private persistNamedRoutes(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const payload = this.savedRoutes().map((route) => this.toPersistedNamedRoute(route));

    try {
      localStorage.setItem(this.namedRoutesStorageKey, JSON.stringify(payload));
    } catch {
      this.errorMessage.set('Falha ao salvar os trajetos nomeados localmente.');
    }
  }

  private clearNamedRoutesStorage(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    localStorage.removeItem(this.namedRoutesStorageKey);
  }

  private restoreNamedRoutes(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const rawNamedRoutes = localStorage.getItem(this.namedRoutesStorageKey);
    if (!rawNamedRoutes) {
      return;
    }

    try {
      const parsed = JSON.parse(rawNamedRoutes) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }

      const restored = parsed
        .map((entry) => this.parseNamedRoute(entry))
        .filter((entry): entry is SavedNamedRoute => entry !== null)
        .sort((first, second) => second.savedAt - first.savedAt)
        .slice(0, this.maxSavedRoutes);

      this.savedRoutes.set(restored);
    } catch {
      this.clearNamedRoutesStorage();
    }
  }

  private persistSession(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const payload: PersistedRouteSession = {
      points: this.routePoints(),
      startedAt: this.startedAt(),
      endedAt: this.endedAt(),
      pointSeq: this.pointSeq
    };

    try {
      localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      this.errorMessage.set('Falha ao salvar os dados localmente.');
    }
  }

  private clearPersistedSession(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    localStorage.removeItem(this.storageKey);
  }

  private restorePersistedSession(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const rawSession = localStorage.getItem(this.storageKey);
    if (!rawSession) {
      return;
    }

    try {
      const parsed = JSON.parse(rawSession) as PersistedRouteSession;
      const restoredPoints = this.sanitizeRoutePoints(parsed.points);

      this.routePoints.set(restoredPoints);
      this.pointSeq =
        typeof parsed.pointSeq === 'number' && parsed.pointSeq >= restoredPoints.length
          ? parsed.pointSeq
          : restoredPoints.length;
      const restoredStartedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : null;
      const restoredEndedAt = typeof parsed.endedAt === 'number' ? parsed.endedAt : null;
      this.startedAt.set(restoredStartedAt);
      this.endedAt.set(
        restoredStartedAt !== null && restoredEndedAt === null ? Date.now() : restoredEndedAt
      );
      this.now.set(Date.now());

      if (restoredPoints.length > 0) {
        this.navigationStatusMessage.set('Percurso restaurado do armazenamento local.');
      }
    } catch {
      this.clearPersistedSession();
    }
  }

  private hydrateMapFromStoredRoute(): void {
    const points = this.routePoints();
    if (!this.map || !this.routeLine || points.length === 0) {
      return;
    }

    const latLngs = points.map((point) => this.toLatLng(point));
    this.routeLine.setLatLngs(latLngs);
    this.updateLiveMarker(points[points.length - 1]);
    this.hasCenteredOnRoute = true;

    const bounds = this.routeLine.getBounds();
    if (bounds.isValid()) {
      this.map.fitBounds(bounds.pad(0.12), { animate: false, maxZoom: this.followZoomLevel });
    }
  }

  private updateInstallState(): void {
    if (typeof window === 'undefined') {
      this.isInstalled.set(false);
      return;
    }

    const standaloneFromDisplayMode = window.matchMedia('(display-mode: standalone)').matches;
    const standaloneFromNavigator =
      typeof navigator !== 'undefined' &&
      'standalone' in navigator &&
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

    this.isInstalled.set(standaloneFromDisplayMode || standaloneFromNavigator);
  }

  private detectInstallPlatform(): InstallPlatform {
    if (typeof navigator === 'undefined') {
      return 'unknown';
    }

    const userAgent = navigator.userAgent.toLowerCase();

    if (/(iphone|ipad|ipod)/.test(userAgent)) {
      return 'ios';
    }

    if (/android/.test(userAgent)) {
      return 'android';
    }

    if (/(windows|macintosh|linux)/.test(userAgent)) {
      return 'desktop';
    }

    return 'unknown';
  }
}
