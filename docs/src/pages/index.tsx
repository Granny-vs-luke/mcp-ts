import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import CodeBlock from '@theme/CodeBlock';
import { Terminal, AnimatedSpan, TypingAnimation } from '../components/Terminal';
import { Boxes } from '../components/BackgroundBoxes';

import styles from './index.module.css';

const showcaseDemos = [
  {
    title: 'AI SDK + remote MCP servers',
    description: 'Watch a Vercel AI SDK app call remote MCP tools through mcp-ts with session management and realtime transport.',
    videoSrc: '/mcp-ts/vid/mcp-ts.mp4',
    tags: ['Remote tools', 'AI SDK'],
    autoPlay: true,
    icon: { src: '/mcp-ts/img/framework/vercel.svg', alt: 'Vercel', width: 16, height: 16 },
  },
  {
    title: 'AG-UI middleware',
    description: 'Streaming middleware that connects LangChain agents to AG-UI with an interaction model built for responsive interfaces.',
    videoSrc: '/mcp-ts/vid/langchain-agui.mp4',
    tags: ['LangChain', 'AG-UI', 'Streaming'],
    icon: { src: '/mcp-ts/img/agent-framework/langchain.svg', alt: 'LangChain', width: 18, height: 18 },
  },
  {
    title: 'MCP Apps',
    description: 'Tool-driven interfaces that expose MCP capabilities through focused, interactive application surfaces.',
    videoSrc: '/mcp-ts/vid/mcp-apps-ext.mp4',
    tags: ['Interactive UI', 'Tooling', 'Apps'],
    icon: { src: '/mcp-ts/img/logo-mark-red.svg', alt: 'mcp-ts', width: 16, height: 16 },
  },
];

const InstallationExample = () => (
  <Terminal>
    <AnimatedSpan delay={0} className={styles.command}>npm install @mcp-ts/sdk</AnimatedSpan>
    <TypingAnimation delay={1000} duration={50}>
      Installing dependencies...
    </TypingAnimation>
    <AnimatedSpan delay={2500} className={styles.success}>OK Package installed successfully</AnimatedSpan>
    <AnimatedSpan delay={3000} className={styles.command}>import {'{'} useMcp {'}'} from '@mcp-ts/sdk/client'</AnimatedSpan>
    <TypingAnimation delay={4000} duration={40}>
      React hook ready for client-side MCP sessions...
    </TypingAnimation>
    <AnimatedSpan delay={5500} className={styles.success}>Ready to use useMcp in your app</AnimatedSpan>
  </Terminal>
);

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className={styles.boxesWrapper}>
        <Boxes />
      </div>
      <div className={styles.maskOverlay} />
      <div className="container" style={{ position: 'relative', zIndex: 20 }}>
        <div className="row">
          <div className={clsx('col col--6', styles.heroText)}>
            <div className={styles.eyebrow}>TypeScript MCP toolkit</div>
            <div className={styles.logoTitle}>
              <img className={styles.logoMark} src="/mcp-ts/img/logo-mark-red.svg" alt="mcp-ts logo" width="64" height="64" />
              <Heading as="h1" className={styles.heroTitle}>
                {siteConfig.title}
              </Heading>
            </div>
            <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
            <p className={styles.heroLead}>
              Build AI-facing apps with a lean SDK for transport, sessions, and realtime MCP flows without hauling in framework-heavy abstractions.
            </p>
            <div className={styles.buttons}>
              <Link
                className={clsx('button button--secondary button--lg', styles.heroButton)}
                to="/docs/">
                Get Started
              </Link>
              <Link
                className={clsx('button button--outline button--secondary button--lg', styles.heroButton, styles.heroButtonOutline)}
                to="/docs/api-reference">
                API Reference
              </Link>
            </div>
          </div>
          <div className={clsx('col col--6', styles.heroTerminalColumn)}>
            <InstallationExample />
          </div>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="Lightweight MCP client library for JavaScript applications with Redis sessions and SSE support">
      <HomepageHeader />
      <main>
        <section className={styles.showcaseSection}>
          <div className="container">
            <div className={styles.sectionHeading}>
              <div className={styles.sectionEyebrow}>Product demos</div>
              <Heading as="h2" className={styles.sectionTitle}>Example demos</Heading>
              <p className={styles.sectionDescription}>
                A featured walkthrough followed by focused examples for agent UIs, middleware, and MCP-powered app experiences.
              </p>
            </div>

            <article className={styles.featuredDemoCard}>
              <div className={styles.demoContent}>
                <div className={styles.demoMetaRow}>
                  <span className={styles.demoMetaIcon}>
                    <img
                      src={showcaseDemos[0].icon.src}
                      alt={showcaseDemos[0].icon.alt}
                      width={showcaseDemos[0].icon.width}
                      height={showcaseDemos[0].icon.height}
                    />
                    Vercel AI SDK
                  </span>
                </div>
                <Heading as="h3" className={styles.demoTitle}>{showcaseDemos[0].title}</Heading>
                <p className={styles.demoDescription}>{showcaseDemos[0].description}</p>
                <div className={styles.demoTagRow}>
                  {showcaseDemos[0].tags.map((tag) => (
                    <span key={tag} className={styles.demoTag}>{tag}</span>
                  ))}
                </div>
              </div>
              <div className={styles.demoFrameLarge}>
                <video
                  src={showcaseDemos[0].videoSrc}
                  width="100%"
                  controls
                  autoPlay={showcaseDemos[0].autoPlay}
                  muted
                  loop
                  playsInline
                  className={styles.demoVideo}
                />
              </div>
            </article>

            <div className={styles.demoGrid}>
              <article id="ag-ui-demo" className={styles.demoCard}>
                <div className={styles.demoCardHeader}>
                  <span className={styles.demoMetaIcon}>
                    <img
                      src={showcaseDemos[1].icon.src}
                      alt={showcaseDemos[1].icon.alt}
                      width={showcaseDemos[1].icon.width}
                      height={showcaseDemos[1].icon.height}
                    />
                    LangChain + AG-UI
                  </span>
                </div>
                <Heading as="h3" className={styles.demoCardTitle}>{showcaseDemos[1].title}</Heading>
                <p className={styles.demoCardDescription}>{showcaseDemos[1].description}</p>
                <div className={styles.demoFrame}>
                  <video
                    src={showcaseDemos[1].videoSrc}
                    width="100%"
                    controls
                    muted
                    loop
                    playsInline
                    className={styles.demoVideo}
                  />
                </div>
                <div className={styles.demoTagRow}>
                  {showcaseDemos[1].tags.map((tag) => (
                    <span key={tag} className={styles.demoTag}>{tag}</span>
                  ))}
                </div>
              </article>

              <article className={styles.demoCard}>
                <div className={styles.demoCardHeader}>
                  <span className={styles.demoMetaIcon}>
                    <img
                      src={showcaseDemos[2].icon.src}
                      alt={showcaseDemos[2].icon.alt}
                      width={showcaseDemos[2].icon.width}
                      height={showcaseDemos[2].icon.height}
                    />
                    mcp-ts apps
                  </span>
                </div>
                <Heading as="h3" className={styles.demoCardTitle}>{showcaseDemos[2].title}</Heading>
                <p className={styles.demoCardDescription}>{showcaseDemos[2].description}</p>
                <div className={styles.demoFrame}>
                  <video
                    src={showcaseDemos[2].videoSrc}
                    width="100%"
                    controls
                    muted
                    loop
                    playsInline
                    className={styles.demoVideo}
                  />
                </div>
                <div className={styles.demoTagRow}>
                  {showcaseDemos[2].tags.map((tag) => (
                    <span key={tag} className={styles.demoTag}>{tag}</span>
                  ))}
                </div>
              </article>
            </div>
          </div>
        </section>
        <section className={styles.features}>
          <div className="container">
            <div className="row">
              <div className="col col--12">
                <div style={{ textAlign: 'center', padding: '3rem 0' }}>
                  <Heading as="h2" style={{ marginBottom: '1.5rem' }}>
                    Why mcp-ts?
                  </Heading>
                  <p style={{ fontSize: '1.2rem', maxWidth: '800px', margin: '0 auto', lineHeight: '1.8' }}>
                    A lightweight, TypeScript-first MCP client for React and serverless apps.
                    Features Redis-backed sessions and real-time updates via SSE.
                  </p>
                </div>
              </div>
            </div>
            <div className="row" style={{ marginTop: '2rem' }}>
              <div className="col col--6">
                <Heading as="h3">Server-Side</Heading>
                <p>
                  Build robust MCP connections with stateless session management
                  and SSE endpoints for real-time updates.
                </p>
                <CodeBlock language="typescript">
                  {`import { MCPClient } from '@mcp-ts/sdk/server';

const client = new MCPClient({
  serverUrl: 'https://mcp.example.com',
  identity: 'user-123'
});

await client.connect();`}
                </CodeBlock>
              </div>
              <div className="col col--6">
                <Heading as="h3">Client-Side</Heading>
                <p>
                  Seamlessly integrate MCP connections into your React applications
                  with the useMcp hook and automatic state synchronization.
                </p>
                <CodeBlock language="tsx">
                  {`import { useMcp } from '@mcp-ts/sdk/client';

function MyComponent() {
  const { connections, connect } = useMcp({
    url: '/api/mcp/sse',
    identity: 'user-123'
  });

  return <div>...</div>;
}`}
                </CodeBlock>
              </div>
            </div>
          </div>
        </section>
        <section style={{ padding: '4rem 0', backgroundColor: 'var(--ifm-background-surface-color)' }}>
          <div className="container">
            <div className="row">
              <div className="col col--8 col--offset-2">
                <Heading as="h2" style={{ textAlign: 'center', marginBottom: '2rem' }}>
                  Frequently Asked Questions
                </Heading>

                <div style={{ marginBottom: '2rem' }}>
                  <Heading as="h3">What is mcp-ts and what is it for?</Heading>
                  <p>
                    <code>mcp-ts</code> acts as a secure bridge between your AI application (like a Vercel AI SDK chatbot)
                    and Model Context Protocol (MCP) servers. It manages connections, handles complex authentication (OAuth),
                    and persists session state using Storage Backends e.g. Redis, allowing your AI agents to use tools from external services reliably.
                  </p>
                </div>

                <div style={{ marginBottom: '2rem' }}>
                  <Heading as="h3">Why Server-Sent Events (SSE) instead of WebSockets?</Heading>
                  <p>
                    SSE is unidirectional and stateless, making it ideal for serverless environments (like Vercel/Next.js)
                    where maintaining long-lived WebSocket connections is difficult, expensive, or subject to timeout limits.
                  </p>
                </div>

                <div style={{ marginBottom: '2rem' }}>
                  <Heading as="h3">Can I use this without Redis?</Heading>
                  <p>
                    Yes! We support <strong>In-Memory</strong> and <strong>File System</strong> storage for local development.
                    However, for production in serverless environments, Redis is required to persist connection state across lambda invocations.
                  </p>
                </div>

                <div style={{ marginBottom: '2rem' }}>
                  <Heading as="h3">Is this compatible with the Vercel AI SDK?</Heading>
                  <p>
                    Absolutely. <code>mcp-ts</code> is designed to plug directly into the AI SDK&apos;s <code>streamText</code> and
                    <code>generateText</code> functions, allowing LLMs to use MCP tools seamlessly.
                  </p>
                </div>

                <div style={{ marginBottom: '2rem' }}>
                  <Heading as="h3">How is authentication handled?</Heading>
                  <p>
                    The library includes detailed OAuth flows, handling token exchange and refresh automatically,
                    so you can connect to secure MCP servers support (like Neon, Github, etc.) out of the box.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
