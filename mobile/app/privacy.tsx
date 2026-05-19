// app/privacy.tsx
// Privacy Policy screen — accessible at /privacy on web and as a native stack screen.
// Required by Google Play and Apple App Store before publishing.

import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

const LAST_UPDATED = "May 19, 2026";
const CONTACT_EMAIL = "trentd187@gmail.com";

function Section({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View className="mb-6">
      <Text className={`text-base font-bold mb-2 ${t.textPrimary}`}>
        {number}. {title}
      </Text>
      {children}
    </View>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Text className={`text-sm leading-relaxed mb-2 ${t.textSecondary}`}>{children}</Text>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View className="flex-row mb-1 pl-2">
      <Text className={`text-sm ${t.textSecondary} mr-2`}>{"•"}</Text>
      <Text className={`text-sm leading-relaxed flex-1 ${t.textSecondary}`}>{children}</Text>
    </View>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Text className={`text-sm font-semibold mb-1 mt-2 ${t.textPrimary}`}>{children}</Text>
  );
}

export default function PrivacyScreen() {
  const router = useRouter();
  const t = useTheme();

  return (
    <View className={`flex-1 ${t.screen}`}>
      {/* Back button — Stack has headerShown: false globally */}
      <View className={`flex-row items-center px-4 pt-12 pb-3 border-b ${t.border}`}>
        <TouchableOpacity
          onPress={() => router.back()}
          className="mr-3 p-1"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={22} color={t.colors.tabBarActive} />
        </TouchableOpacity>
        <Text className={`text-lg font-bold ${t.textPrimary}`}>Privacy Policy</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Text className="text-2xl font-bold text-green-700 mb-1">Golf Stuff In Here</Text>
        <Text className={`text-xs mb-6 ${t.textTertiary}`}>Last Updated: {LAST_UPDATED}</Text>

        <Body>
          This Privacy Policy explains how Trent Dahlheimer ("we," "us," or "our") collects,
          uses, shares, and protects information about you when you use Golf Stuff In Here (the
          "Service"). By using the Service, you agree to the practices described in this policy.
        </Body>

        {/* ── 1. Information We Collect ── */}
        <Section number="1" title="Information We Collect">
          <SubHeading>1.1 Information You Provide Directly</SubHeading>
          <Bullet>
            Account information — your email address and display name, provided when you sign up
            via email OTP or Google OAuth
          </Bullet>
          <Bullet>
            Profile photo — either your Google account photo (imported automatically on first
            sign-in) or a photo you upload manually
          </Bullet>
          <Bullet>
            Golf data — scores, statistics, course handicaps, round details, and event or league
            participation records you enter into the Service
          </Bullet>
          <Bullet>
            Scorecard preferences — which stats to display, their order, and related display
            settings
          </Bullet>
          <Bullet>
            Social connections — the list of other users you choose to follow within the Service
          </Bullet>

          <SubHeading>1.2 Information Collected Automatically</SubHeading>
          <Bullet>
            Usage and diagnostic logs — structured log events (e.g., screen views, authentication
            events, API errors) collected to monitor service health. Logs include timestamps,
            event names, and anonymous session identifiers. They do not include your golf scores
            or personal profile data.
          </Bullet>
          <Bullet>
            Distributed traces — technical request traces that link your mobile app activity to
            backend processing for performance diagnostics. Traces are retained for 13 days by
            our observability provider (Grafana Cloud).
          </Bullet>
          <Bullet>
            Device and platform signals — operating system type (iOS or Android or web) used to
            adapt the interface; no persistent device identifiers are stored by us.
          </Bullet>

          <SubHeading>1.3 Information from Third Parties</SubHeading>
          <Bullet>
            Google OAuth — if you sign in with Google, we receive your name and email address from
            Google. We do not receive your Google contacts, calendar, or any other Google account
            data.
          </Bullet>
          <Bullet>
            GolfCourseAPI.com — when you import a golf course, we receive course name, tee
            information, par, slope, and hole data from this third-party source. No personal data
            is involved.
          </Bullet>
        </Section>

        {/* ── 2. How We Use Your Information ── */}
        <Section number="2" title="How We Use Your Information">
          <Body>We use the information we collect to:</Body>
          <Bullet>Create and manage your account and authenticate your identity</Bullet>
          <Bullet>Store and display your golf scores, stats, and event history</Bullet>
          <Bullet>Enable league and tournament management features</Bullet>
          <Bullet>Display your public profile and stats to other users you follow or who follow you</Bullet>
          <Bullet>Monitor service health, diagnose errors, and improve reliability</Bullet>
          <Bullet>Respond to your support requests or questions</Bullet>
          <Bullet>Comply with legal obligations</Bullet>
          <Body>
            We do not use your information for advertising, profiling, or sale to third parties.
          </Body>
        </Section>

        {/* ── 3. How We Share Your Information ── */}
        <Section number="3" title="How We Share Your Information">
          <Body>
            We do not sell, rent, or trade your personal information. We share information only
            in the following limited circumstances:
          </Body>
          <Bullet>
            With other users — your display name, profile photo, and golf stats are visible to
            users within the same events or leagues, and to any user who views your public profile
          </Bullet>
          <Bullet>
            With service providers — we share data with the third-party providers listed in
            Section 4 solely to operate the Service
          </Bullet>
          <Bullet>
            For legal compliance — if required by law, court order, or governmental authority, or
            to protect the rights, property, or safety of users or the public
          </Bullet>
          <Bullet>
            In a business transfer — if we merge with or are acquired by another entity, your
            information may be transferred as part of that transaction, subject to the same
            privacy protections
          </Bullet>
        </Section>

        {/* ── 4. Third-Party Service Providers ── */}
        <Section number="4" title="Third-Party Service Providers">
          <Body>
            We rely on the following providers to operate the Service. Each provider has its own
            privacy policy governing how it handles data:
          </Body>

          <SubHeading>Supabase</SubHeading>
          <Body>
            Handles authentication (email OTP and Google OAuth), stores your account data and
            golf records in a PostgreSQL database, and hosts your profile photos. Data is
            stored in Supabase's managed infrastructure. Privacy policy: supabase.com/privacy
          </Body>

          <SubHeading>Google</SubHeading>
          <Body>
            Provides OAuth sign-in. When you use "Continue with Google," Google authenticates
            you and shares your name and email with us. Privacy policy: policies.google.com/privacy
          </Body>

          <SubHeading>Grafana Cloud</SubHeading>
          <Body>
            Receives diagnostic logs and distributed traces from the Service for performance
            monitoring and error detection. Logs and traces do not contain your golf scores or
            profile data. Retention: 13 days for traces; 30 days for logs.
            Privacy policy: grafana.com/legal/privacy-policy
          </Body>

          <SubHeading>Railway</SubHeading>
          <Body>
            Hosts the backend API server and database. Your data resides in Railway's cloud
            infrastructure. Privacy policy: railway.app/legal/privacy
          </Body>

          <SubHeading>GolfCourseAPI.com</SubHeading>
          <Body>
            Provides golf course data (name, tees, par, slope, hole details) when you search for
            or import a course. No personal data is sent to this service.
          </Body>
        </Section>

        {/* ── 5. Data Retention ── */}
        <Section number="5" title="Data Retention">
          <Body>
            We retain your account information and golf data for as long as your account is
            active or as needed to provide the Service. If you request account deletion, we will
            delete your personal information within a reasonable time, except:
          </Body>
          <Bullet>
            Data retained in database backups, which are purged on a rolling basis (typically
            within 30 days)
          </Bullet>
          <Bullet>
            Data we are required to retain by applicable law
          </Bullet>
          <Bullet>
            Anonymized or aggregated data that no longer identifies you
          </Bullet>
          <Body>
            Diagnostic logs in Grafana Cloud are retained for 30 days and traces for 13 days,
            after which they are automatically deleted by the provider.
          </Body>
        </Section>

        {/* ── 6. Data Security ── */}
        <Section number="6" title="Data Security">
          <Body>
            We take reasonable technical and organizational measures to protect your information,
            including:
          </Body>
          <Bullet>
            Authentication via Supabase Auth using RS256-signed JWTs — no passwords are stored
            by us
          </Bullet>
          <Bullet>HTTPS encryption for all data in transit</Bullet>
          <Bullet>Row-level access controls so users can only access their own data and data from events they participate in</Bullet>
          <Body>
            No method of electronic storage or transmission is 100% secure. While we strive to
            use commercially acceptable means to protect your information, we cannot guarantee
            absolute security.
          </Body>
        </Section>

        {/* ── 7. Your Rights and Choices ── */}
        <Section number="7" title="Your Rights and Choices">
          <Body>
            Depending on your location, you may have rights regarding your personal information,
            including:
          </Body>
          <Bullet>
            Access — request a copy of the personal information we hold about you
          </Bullet>
          <Bullet>
            Correction — request that we correct inaccurate or incomplete information
          </Bullet>
          <Bullet>
            Deletion — request that we delete your account and associated personal information
          </Bullet>
          <Bullet>
            Portability — request your golf data in a structured, machine-readable format
          </Bullet>
          <Body>
            To exercise any of these rights, contact us at {CONTACT_EMAIL}. We will respond
            within a reasonable time and may ask you to verify your identity before processing
            your request.
          </Body>
          <Body>
            You may also update or correct your display name and profile photo directly from
            within the app at any time.
          </Body>
        </Section>

        {/* ── 8. Children's Privacy ── */}
        <Section number="8" title="Children's Privacy">
          <Body>
            The Service is not directed to children under 13 years of age. We do not knowingly
            collect personal information from children under 13. If you are a parent or guardian
            and believe your child under 13 has provided us with personal information, please
            contact us at {CONTACT_EMAIL} and we will delete that information promptly.
          </Body>
          <Body>
            Users between 13 and 18 years of age may use the Service only with the involvement
            and consent of a parent or legal guardian.
          </Body>
        </Section>

        {/* ── 9. California Privacy Rights ── */}
        <Section number="9" title="California Privacy Rights">
          <Body>
            If you are a California resident, the California Consumer Privacy Act (CCPA) may
            provide you with additional rights regarding your personal information. Because we
            do not sell personal information, the CCPA's opt-out-of-sale right does not apply.
            California residents may still contact us to exercise access and deletion rights
            described in Section 7.
          </Body>
        </Section>

        {/* ── 10. International Users ── */}
        <Section number="10" title="International Users">
          <Body>
            The Service is operated from the United States. If you access the Service from
            outside the United States, your information will be transferred to and processed in
            the United States, where data protection laws may differ from those in your country.
            By using the Service, you consent to this transfer and processing.
          </Body>
        </Section>

        {/* ── 11. Changes to This Policy ── */}
        <Section number="11" title="Changes to This Policy">
          <Body>
            We may update this Privacy Policy from time to time. We will notify you of material
            changes by updating the "Last Updated" date at the top of this page and, where
            appropriate, by providing notice through the Service. Continued use of the Service
            after any changes constitutes your acceptance of the updated policy.
          </Body>
        </Section>

        {/* ── 12. Contact Us ── */}
        <Section number="12" title="Contact Us">
          <Body>
            If you have any questions, concerns, or requests regarding this Privacy Policy or
            our data practices, please contact us:
          </Body>
          <Body>
            Trent Dahlheimer{"\n"}
            Email: {CONTACT_EMAIL}
          </Body>
        </Section>
      </ScrollView>
    </View>
  );
}
