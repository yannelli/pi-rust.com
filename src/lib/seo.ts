/**
 * JSON-LD builders. Every page links to the same WebSite, software, and Person
 * nodes by @id. The Person is the one ryanyannelli.com describes, so search
 * engines can join the two sites on one maintainer.
 */
import { AUTHOR, RELEASE, RELEASES_URL, REPO_URL, SITE_NAME, SITE_URL, UPSTREAM_AUTHOR, UPSTREAM_PI_URL } from './site';

export const WEBSITE_ID = `${SITE_URL}/#website`;
export const SOFTWARE_ID = `${SITE_URL}/#software`;

export const abs = (path: string) => (path.startsWith('http') ? path : `${SITE_URL}${path.startsWith('/') ? '' : '/'}${path}`);

export const personRef = () => ({ '@type': 'Person' as const, '@id': AUTHOR.id, name: AUTHOR.name, url: AUTHOR.url });

export function person() {
  return { '@type': 'Person', '@id': AUTHOR.id, name: AUTHOR.name, url: AUTHOR.url, sameAs: [...AUTHOR.sameAs] };
}

export function website() {
  return {
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    name: SITE_NAME,
    alternateName: 'pi-rust.com',
    url: `${SITE_URL}/`,
    inLanguage: 'en',
    description: 'The website and documentation of pi-rust, the Rust port of the pi coding agent.',
    publisher: personRef(),
    about: { '@id': SOFTWARE_ID },
  };
}

export function software(description: string) {
  return {
    '@type': ['SoftwareApplication', 'SoftwareSourceCode'],
    '@id': SOFTWARE_ID,
    name: SITE_NAME,
    alternateName: 'pi',
    description,
    url: `${SITE_URL}/`,
    image: abs('/og/home.png'),
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'Coding agent',
    featureList: [
      'Drop-in replacement for pi: reads ~/.pi/agent logins, settings, models, sessions, and MCP servers',
      'Runs pi TypeScript extensions, skills, prompt templates, themes, and packages as they are',
      'Built for 1:1 parity with upstream pi, checked by a daily workflow',
      'Session files and RPC and JSON events match upstream pi byte for byte',
      'Extensions run on a built-in QuickJS engine, so no Node.js is needed',
      'Streaming API for models from many providers, an agent loop that calls tools, and the pi CLI',
      'ACP mode for Zed and other editors, and an MCP client over stdio and HTTP',
    ],
    operatingSystem: 'Linux, macOS, Windows',
    softwareVersion: RELEASE.version,
    dateModified: RELEASE.date,
    downloadUrl: `${RELEASES_URL}/latest`,
    installUrl: `${SITE_URL}/install/`,
    releaseNotes: `${SITE_URL}/changelog/`,
    codeRepository: REPO_URL,
    programmingLanguage: 'Rust',
    license: 'https://opensource.org/license/mit',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: personRef(),
    maintainer: personRef(),
    isBasedOn: {
      '@type': 'SoftwareSourceCode',
      name: 'pi',
      codeRepository: UPSTREAM_PI_URL,
      programmingLanguage: 'TypeScript',
      author: { '@type': 'Person', name: UPSTREAM_AUTHOR.name },
    },
    sameAs: [REPO_URL, AUTHOR.projectUrl],
  };
}

export function techArticle(input: { title: string; description: string; path: string; image: string }) {
  const url = abs(input.path);
  return {
    '@type': 'TechArticle',
    '@id': `${url}#article`,
    headline: input.title,
    description: input.description,
    url,
    image: abs(input.image),
    inLanguage: 'en',
    dateModified: RELEASE.date,
    version: RELEASE.version,
    author: personRef(),
    publisher: personRef(),
    about: { '@id': SOFTWARE_ID },
    isPartOf: { '@id': WEBSITE_ID },
    mainEntityOfPage: url,
  };
}

export function breadcrumbs(items: { name: string; path: string }[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: abs(item.path) })),
  };
}

export function faqPage(path: string, questions: { question: string; answer: string }[]) {
  return {
    '@type': 'FAQPage',
    '@id': `${abs(path)}#faq`,
    url: abs(path),
    about: { '@id': SOFTWARE_ID },
    mainEntity: questions.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}
