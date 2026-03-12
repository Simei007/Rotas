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

  private readonly startedAt = signal<number | null>(null);
  private readonly endedAt = signal<number | null>(null);
  private readonly now = signal(Date.now());

  private watchId: number | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private pointSeq = 0;
  private map: L.Map | null = null;
  private routeLine: L.Polyline | null = null;
  private liveMarker: L.CircleMarker | null = null;
  private hasCenteredOnRoute = false;
  private readonly initialCenter: L.LatLngTuple = [-23.55052, -46.633308];
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
  }

  ngAfterViewInit(): void {
    this.initializeMap();
  }

  ngOnDestroy(): void {
    this.stopLocationTracking();
    this.destroyMap();
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

  protected startRecording(): void {
    if (!this.hasGeolocation || this.isRecording()) {
      return;
    }

    this.errorMessage.set(null);
    this.routePoints.set([]);
    this.pointSeq = 0;
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

    this.routePoints.set([]);
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

    setTimeout(() => this.map?.invalidateSize(), 0);
  }

  private updateMapRoute(point: RoutePoint): void {
    if (!this.map || !this.routeLine) {
      return;
    }

    const latLng: L.LatLngTuple = [point.latitude, point.longitude];
    this.routeLine.addLatLng(latLng);

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

    if (!this.hasCenteredOnRoute) {
      this.map.setView(latLng, 18);
      this.hasCenteredOnRoute = true;
      return;
    }

    const bounds = this.routeLine.getBounds();
    if (bounds.isValid()) {
      this.map.fitBounds(bounds.pad(0.18), { animate: false, maxZoom: 18 });
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

  private destroyMap(): void {
    if (this.map) {
      this.map.remove();
      this.map = null;
      this.routeLine = null;
      this.liveMarker = null;
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
