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

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild('mapPanel') private mapPanel?: ElementRef<HTMLElement>;
  @ViewChild('mapContainer') private mapContainer?: ElementRef<HTMLDivElement>;

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

  private readonly startedAt = signal<number | null>(null);
  private readonly endedAt = signal<number | null>(null);
  private readonly now = signal(Date.now());

  private watchId: number | null = null;
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
  private deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
  private displayModeQuery: MediaQueryList | null = null;

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
      this.setBodyScrollLock(false);
    }

    this.scheduleMapResize();
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
  protected readonly canReviewRoute = computed(
    () => this.routePoints().length > 1 && !this.isRecording() && !this.isReviewing()
  );
  protected readonly reviewProgressMessage = computed(() => {
    if (!this.isReviewing()) {
      return null;
    }

    const total = this.routePoints().length;
    const current = Math.min(this.reviewPointIndex() + 1, total);
    return `Revisando ponto ${current} de ${total}.`;
  });
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
    }
  }

  ngAfterViewInit(): void {
    this.initializeMap();
  }

  ngOnDestroy(): void {
    this.stopReviewPlayback(false);
    this.stopLocationTracking();
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

  protected async toggleMapExpanded(): Promise<void> {
    if (typeof document === 'undefined') {
      return;
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
    this.setBodyScrollLock(nextFallbackValue);
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

  protected startRecording(): void {
    if (!this.hasGeolocation || this.isRecording()) {
      return;
    }

    this.stopReviewPlayback(false);

    this.errorMessage.set(null);
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
  }

  protected clearRoute(): void {
    if (this.isRecording()) {
      return;
    }

    this.stopReviewPlayback(false);
    this.routePoints.set([]);
    this.reviewPointIndex.set(0);
    this.startedAt.set(null);
    this.endedAt.set(null);
    this.now.set(Date.now());
    this.errorMessage.set(null);
    this.resetMapRoute();
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
  }

  private handlePositionError(error: GeolocationPositionError): void {
    switch (error.code) {
      case error.PERMISSION_DENIED:
        this.errorMessage.set('Permissao de localizacao negada. Ative a permissao para gravar rotas.');
        break;
      case error.POSITION_UNAVAILABLE:
        this.errorMessage.set('Localizacao indisponivel no momento. Tente novamente em uma area aberta.');
        break;
      case error.TIMEOUT:
        this.errorMessage.set('Tempo limite excedido ao buscar localizacao.');
        break;
      default:
        this.errorMessage.set('Erro inesperado ao capturar localizacao.');
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

  private scheduleMapResize(): void {
    setTimeout(() => this.map?.invalidateSize(), 80);
    setTimeout(() => this.map?.invalidateSize(), 240);
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
