// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

// React + Web3 Essentials
import Head from '@docusaurus/Head';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import React from 'react';

// External Components
import styled from 'styled-components';

// Internal Components
import { Button, ItemV } from '@site/src/css/SharedStyling';

// Internal Configs
import { PageMeta } from '@site/src/config/pageMeta';

function CheatSheet() {
  const url =
    'https://drive.google.com/file/d/1FBlUvoLJ4RoExUihwu-YqRtWfnDUxsuW/view?usp=sharing';
  const redirectURL = () => {
    window.location.replace(url);
  };

  return (
    <Layout
      title={PageMeta.CHEAT.pageTitle}
      description={PageMeta.CHEAT.pageDescription}
      showNavbar='website'
    >
      <Head>
        {/* <!-- Facebook Meta Tags --> */}
        <meta property='og:url' content='https://comms.push.org/cheatsheet' />
        <meta property='og:type' content='website' />
        <meta property='og:title' content='Push | Cheatsheet' />
        <meta
          property='og:description'
          content='Explore our comprehensive cheat sheet, packed with quick references, tips, and key information to master the subject. Get a handy resource to boost your knowledge and productivity instantly.'
        />
        <meta
          property='og:image'
          content={useBaseUrl(
            require('/static/assets/previews/cheatsheetpreview.png').default,
            { absolute: true }
          )}
        />

        {/* <!-- Twitter Meta Tags --> */}
        <meta name='twitter:card' content='summary_large_image' />
        <meta name='twitter:site' content='@PushChain' />
        <meta name='twitter:title' content='Push | Cheatsheet' />
        <meta
          name='twitter:description'
          content='Explore our comprehensive cheat sheet, packed with quick references, tips, and key information to master the subject. Get a handy resource to boost your knowledge and productivity instantly.'
        />
        <meta
          property='twitter:image'
          content={useBaseUrl(
            require('/static/assets/previews/cheatsheetpreview.png').default,
            { absolute: true }
          )}
        />

        <script type='application/ld+json'>
          {JSON.stringify({
            '@context': 'https://schema.org/',
            '@type': 'Organization',
            name: 'Push Protocol',
            description: 'The Communication Protocol of Web3',
            url: 'https://comms.push.org',
            logo: '/assets/website/favicon.ico',
            sameAs: [
              'https://x.com/PushChain',
              'https://www.linkedin.com/company/push-protocol/mycompany/',
            ],
          })}
        </script>
      </Head>

      <CheatWrapper>
        <TextDiv>Click below to view CheatSheet 👇🏾 </TextDiv>
        <Button
          target='_blank'
          title='Push Dapp'
          background='#DD44B9'
          borderRadius='16px'
          fontSize='18px'
          fontWeight='500'
          letterSpacing='-0.03em'
          lineHeight='26px'
          onClick={redirectURL}
        >
          View Cheatsheet
        </Button>
      </CheatWrapper>
    </Layout>
  );
}

const CheatWrapper = styled(ItemV)`
  max-height: 100vh;
  min-height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background: #121315;
`;

const TextDiv = styled.div`
  color: white;
  margin-bottom: 40px;
`;

export default CheatSheet;
