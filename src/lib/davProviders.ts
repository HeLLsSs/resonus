/**
 * The clouds that can be added as a share, and the address each of them wants.
 *
 * A WebDAV share is a URL, a name and a password, and the URL is the part
 * nobody knows by heart: every service hides it in a help page under a
 * different name, and half of them have one address for Europe and another for
 * everywhere else. So the ones that can be named are named, and choosing one
 * fills the address in.
 *
 * **What is not here** is Google Drive, Dropbox and OneDrive. None of the three
 * speaks WebDAV — they each have an API of their own reached by signing in
 * through their own page, which needs a key registered with them in the name of
 * this app. That key cannot be written here: it belongs to whoever publishes
 * the app, and there is no way to ask for one on somebody's behalf.
 *
 * `url` is what goes in the address field. Where a service puts the account
 * name in the path, `{user}` stands in for it and is filled in from what is
 * typed; where it does not, the placeholder simply never appears.
 */
export interface DavProvider {
  /** What it is called, as its own users would call it. */
  name: string;
  /** The address, with `{user}` where the account name belongs. */
  url: string;
  /**
   * What somebody has to know before this works: almost always that the
   * account password is not the one to use. Shown under the address.
   */
  note?: string;
}

/** A short list on purpose: a cloud nobody here uses is a line to read past. */
export const DAV_PROVIDERS: DavProvider[] = [
  {
    name: 'Nextcloud / ownCloud',
    url: 'https://{host}/remote.php/dav/files/{user}',
    note: 'Settings › Security › Devices & sessions makes an app password. Replace {host} with your own address.',
  },
  {
    name: 'pCloud',
    url: 'https://webdav.pcloud.com',
    note: 'Use ewebdav.pcloud.com instead if your account was created in Europe.',
  },
  { name: 'Koofr', url: 'https://app.koofr.net/dav/Koofr', note: 'Koofr wants an app password, made under Preferences › Password.' },
  { name: 'Yandex Disk', url: 'https://webdav.yandex.com' },
  { name: 'Mail.ru Cloud', url: 'https://webdav.cloud.mail.ru' },
  { name: 'Box', url: 'https://dav.box.com/dav', note: 'Box asks for an external app password where two-factor sign-in is on.' },
  { name: 'Fastmail Files', url: 'https://myfiles.fastmail.com/{user}', note: 'Fastmail needs an app password with the Files access.' },
  {
    name: 'Infomaniak kDrive',
    url: 'https://connect.drive.infomaniak.com/{drive}',
    note: 'Replace {drive} with the number in your kDrive address, and use an application password.',
  },
];

/** The address with what was typed put into it, ready to be tried. */
export function fillProviderUrl(url: string, user: string): string {
  return url.replace('{user}', encodeURIComponent(user.trim()));
}
