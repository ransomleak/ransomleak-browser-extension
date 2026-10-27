// Sensitive-paste overlay strings. Locale: the tenant's language first, then the browser language
// (same rule as the consent overlay), then English. `{what}` is replaced by the category phrase.
import type { PasteCategory } from '../../detect/sensitive-paste.ts';

const en = {
  titleWarn: 'Check this before you paste it',
  titleBlock: 'This paste is blocked',
  bodyWarn: 'This paste may contain {what}. Your security team asks you not to share it with AI tools.',
  bodyBlock: 'This paste may contain {what}. Your security team doesn\'t allow sharing it with AI tools.',
  secret: 'a password, API key or access token',
  card: 'a payment card number',
  emails: 'a list of email addresses',
  large: 'a large amount of text, such as a document or code',
  cancel: 'Don\'t paste',
  paste: 'Paste anyway',
  ok: 'OK',
};
export type MsgKey = keyof typeof en;
type Table = Record<MsgKey, string>;

const de: Table = {
  titleWarn: 'Prüfen Sie das, bevor Sie es einfügen',
  titleBlock: 'Dieses Einfügen ist blockiert',
  bodyWarn: 'Der eingefügte Inhalt enthält möglicherweise {what}. Ihr Sicherheitsteam bittet Sie, so etwas nicht mit KI-Tools zu teilen.',
  bodyBlock: 'Der eingefügte Inhalt enthält möglicherweise {what}. Ihr Sicherheitsteam erlaubt nicht, so etwas mit KI-Tools zu teilen.',
  secret: 'ein Passwort, einen API-Schlüssel oder ein Zugriffstoken',
  card: 'eine Zahlungskartennummer',
  emails: 'eine Liste von E-Mail-Adressen',
  large: 'eine große Textmenge, etwa ein Dokument oder Code',
  cancel: 'Nicht einfügen',
  paste: 'Trotzdem einfügen',
  ok: 'OK',
};
const fr: Table = {
  titleWarn: 'Vérifiez avant de coller',
  titleBlock: 'Ce collage est bloqué',
  bodyWarn: 'Ce contenu peut contenir {what}. Votre équipe de sécurité vous demande de ne pas le partager avec des outils d\'IA.',
  bodyBlock: 'Ce contenu peut contenir {what}. Votre équipe de sécurité n\'autorise pas son partage avec des outils d\'IA.',
  secret: 'un mot de passe, une clé d\'API ou un jeton d\'accès',
  card: 'un numéro de carte de paiement',
  emails: 'une liste d\'adresses e-mail',
  large: 'une grande quantité de texte, comme un document ou du code',
  cancel: 'Ne pas coller',
  paste: 'Coller quand même',
  ok: 'OK',
};
const it: Table = {
  titleWarn: 'Controlla prima di incollare',
  titleBlock: 'Questo incolla è bloccato',
  bodyWarn: 'Questo contenuto potrebbe includere {what}. Il tuo team di sicurezza ti chiede di non condividerlo con strumenti di IA.',
  bodyBlock: 'Questo contenuto potrebbe includere {what}. Il tuo team di sicurezza non consente di condividerlo con strumenti di IA.',
  secret: 'una password, una chiave API o un token di accesso',
  card: 'un numero di carta di pagamento',
  emails: 'un elenco di indirizzi email',
  large: 'una grande quantità di testo, come un documento o del codice',
  cancel: 'Non incollare',
  paste: 'Incolla comunque',
  ok: 'OK',
};
const nl: Table = {
  titleWarn: 'Controleer dit voordat je het plakt',
  titleBlock: 'Plakken is geblokkeerd',
  bodyWarn: 'Wat je plakt bevat mogelijk {what}. Je beveiligingsteam vraagt je dit niet met AI-tools te delen.',
  bodyBlock: 'Wat je plakt bevat mogelijk {what}. Je beveiligingsteam staat niet toe dat je dit met AI-tools deelt.',
  secret: 'een wachtwoord, API-sleutel of toegangstoken',
  card: 'een betaalkaartnummer',
  emails: 'een lijst met e-mailadressen',
  large: 'een grote hoeveelheid tekst, zoals een document of code',
  cancel: 'Niet plakken',
  paste: 'Toch plakken',
  ok: 'OK',
};
const uk: Table = {
  titleWarn: 'Перевірте це, перш ніж вставити',
  titleBlock: 'Вставлення заблоковано',
  bodyWarn: 'Те, що ви вставляєте, може містити {what}. Ваша команда безпеки просить не ділитися цим з інструментами ШІ.',
  bodyBlock: 'Те, що ви вставляєте, може містити {what}. Ваша команда безпеки не дозволяє ділитися цим з інструментами ШІ.',
  secret: 'пароль, API-ключ або токен доступу',
  card: 'номер платіжної картки',
  emails: 'список адрес електронної пошти',
  large: 'великий обсяг тексту, наприклад документ або код',
  cancel: 'Не вставляти',
  paste: 'Усе одно вставити',
  ok: 'OK',
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

export interface PasteText { title: string; body: string; cancel: string; paste: string; ok: string }

export function pasteText(category: PasteCategory, block: boolean, locale = 'en'): PasteText {
  const tb = ALL[locale] ?? en;
  return {
    title: block ? tb.titleBlock : tb.titleWarn,
    body: (block ? tb.bodyBlock : tb.bodyWarn).replace('{what}', tb[category]),
    cancel: tb.cancel,
    paste: tb.paste,
    ok: tb.ok,
  };
}
