// Consent overlay strings. Locale comes from the tenant's language (auth.locale, same source the
// password warning uses), falling back to the browser language, then English.
const en = {
  titleWarn: 'Review this app before you grant access',
  titleBlock: 'Your organization blocks this app',
  bodyWarn: 'This app is asking for access your security team considers risky. Only continue if you know the app and expected this request.',
  bodyBlock: 'Your security team doesn\'t allow this app to access your account. If you need it for work, ask them to approve it.',
  appLabel: 'App',
  reasonBroad: 'Wants broad access to your account',
  reasonUnverified: 'The publisher is not verified',
  back: 'Go back',
  cont: 'Continue anyway',
  request: 'Request access',
  requested: 'Request sent',
};
export type MsgKey = keyof typeof en;
type Table = Record<MsgKey, string>;

const de: Table = {
  titleWarn: 'Prüfen Sie diese App, bevor Sie Zugriff gewähren',
  titleBlock: 'Ihre Organisation blockiert diese App',
  bodyWarn: 'Diese App fordert Zugriffe an, die Ihr Sicherheitsteam als riskant einstuft. Fahren Sie nur fort, wenn Sie die App kennen und diese Anfrage erwartet haben.',
  bodyBlock: 'Ihr Sicherheitsteam erlaubt dieser App keinen Zugriff auf Ihr Konto. Wenn Sie sie für die Arbeit brauchen, bitten Sie um Freigabe.',
  appLabel: 'App',
  reasonBroad: 'Möchte weitreichenden Zugriff auf Ihr Konto',
  reasonUnverified: 'Der Herausgeber ist nicht verifiziert',
  back: 'Zurück',
  cont: 'Trotzdem fortfahren',
  request: 'Zugriff anfordern',
  requested: 'Anfrage gesendet',
};
const fr: Table = {
  titleWarn: 'Vérifiez cette application avant d\'autoriser l\'accès',
  titleBlock: 'Votre organisation bloque cette application',
  bodyWarn: 'Cette application demande un accès que votre équipe de sécurité juge risqué. Ne continuez que si vous connaissez l\'application et attendiez cette demande.',
  bodyBlock: 'Votre équipe de sécurité n\'autorise pas cette application à accéder à votre compte. Si vous en avez besoin pour le travail, demandez-lui de l\'approuver.',
  appLabel: 'Application',
  reasonBroad: 'Demande un accès étendu à votre compte',
  reasonUnverified: 'L\'éditeur n\'est pas vérifié',
  back: 'Revenir en arrière',
  cont: 'Continuer quand même',
  request: 'Demander l\'accès',
  requested: 'Demande envoyée',
};
const it: Table = {
  titleWarn: 'Controlla questa app prima di concedere l\'accesso',
  titleBlock: 'La tua organizzazione blocca questa app',
  bodyWarn: 'Questa app chiede un accesso che il tuo team di sicurezza considera rischioso. Continua solo se conosci l\'app e ti aspettavi questa richiesta.',
  bodyBlock: 'Il tuo team di sicurezza non consente a questa app di accedere al tuo account. Se ti serve per lavoro, chiedi di approvarla.',
  appLabel: 'App',
  reasonBroad: 'Vuole un accesso ampio al tuo account',
  reasonUnverified: 'L\'editore non è verificato',
  back: 'Torna indietro',
  cont: 'Continua comunque',
  request: 'Richiedi accesso',
  requested: 'Richiesta inviata',
};
const nl: Table = {
  titleWarn: 'Controleer deze app voordat je toegang geeft',
  titleBlock: 'Je organisatie blokkeert deze app',
  bodyWarn: 'Deze app vraagt om toegang die je beveiligingsteam als riskant beschouwt. Ga alleen verder als je de app kent en dit verzoek verwachtte.',
  bodyBlock: 'Je beveiligingsteam staat niet toe dat deze app je account gebruikt. Heb je hem nodig voor je werk, vraag dan om goedkeuring.',
  appLabel: 'App',
  reasonBroad: 'Wil brede toegang tot je account',
  reasonUnverified: 'De uitgever is niet geverifieerd',
  back: 'Ga terug',
  cont: 'Toch doorgaan',
  request: 'Toegang aanvragen',
  requested: 'Verzoek verstuurd',
};
const uk: Table = {
  titleWarn: 'Перевірте цей застосунок, перш ніж надати доступ',
  titleBlock: 'Ваша організація блокує цей застосунок',
  bodyWarn: 'Цей застосунок просить доступ, який ваша команда безпеки вважає ризикованим. Продовжуйте, лише якщо знаєте застосунок і очікували цей запит.',
  bodyBlock: 'Ваша команда безпеки не дозволяє цьому застосунку доступ до вашого облікового запису. Якщо він потрібен для роботи, попросіть його схвалити.',
  appLabel: 'Застосунок',
  reasonBroad: 'Хоче широкий доступ до вашого облікового запису',
  reasonUnverified: 'Видавця не перевірено',
  back: 'Повернутися',
  cont: 'Усе одно продовжити',
  request: 'Запросити доступ',
  requested: 'Запит надіслано',
};

const ALL: Record<string, Table> = { en, de, fr, it, nl, uk };

/** Picks a supported locale: the tenant locale first, then the browser language, then 'en'. */
export function pickLocale(tenant?: string | null, browser?: string | null): string {
  for (const c of [tenant, browser]) {
    const base = (c ?? '').toLowerCase().split(/[-_]/)[0]!;
    if (base in ALL) return base;
  }
  return 'en';
}
export const t = (k: MsgKey, locale = 'en'): string => (ALL[locale] ?? en)[k];
