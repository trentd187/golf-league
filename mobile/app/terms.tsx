// app/terms.tsx
// Terms of Service screen — accessible at /terms on web and as a native stack screen.
// Required by Google Play and Apple App Store before publishing.

import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

const LAST_UPDATED = "May 19, 2026";
const CONTACT_EMAIL = "trentd187@gmail.com";

// Section renders a numbered heading + body block.
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

// Body renders a standard paragraph of body text.
function Body({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Text className={`text-sm leading-relaxed mb-2 ${t.textSecondary}`}>{children}</Text>
  );
}

// Bullet renders a single bullet-point line.
function Bullet({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View className="flex-row mb-1 pl-2">
      <Text className={`text-sm ${t.textSecondary} mr-2`}>{"•"}</Text>
      <Text className={`text-sm leading-relaxed flex-1 ${t.textSecondary}`}>{children}</Text>
    </View>
  );
}

// Caps renders ALL-CAPS disclaimer blocks (limitation of liability / disclaimers).
function Caps({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Text className={`text-xs leading-relaxed mb-2 font-medium ${t.textSecondary}`}>{children}</Text>
  );
}

export default function TermsScreen() {
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
        <Text className={`text-lg font-bold ${t.textPrimary}`}>Terms of Service</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Text className="text-2xl font-bold text-green-700 mb-1">Golf Stuff In Here</Text>
        <Text className={`text-xs mb-6 ${t.textTertiary}`}>Last Updated: {LAST_UPDATED}</Text>

        <Body>
          Please read these Terms of Service carefully before using Golf Stuff In Here. By
          accessing or using the Service, you agree to be bound by these Terms.
        </Body>

        {/* ── 1. Acceptance ── */}
        <Section number="1" title="Acceptance of Terms">
          <Body>
            These Terms of Service ("Terms") govern your access to and use of the Golf Stuff In
            Here mobile application and any associated website (collectively, the "Service"),
            operated by Trent Dahlheimer ("we," "us," or "our"). By downloading, installing,
            accessing, or using the Service, you agree to these Terms. If you do not agree, you
            must not use the Service.
          </Body>
        </Section>

        {/* ── 2. Eligibility ── */}
        <Section number="2" title="Eligibility">
          <Body>
            You must be at least 13 years old to use the Service. By using the Service, you
            represent and warrant that you are at least 13 years of age. If you are between 13 and
            18, you represent that a parent or legal guardian has reviewed and agreed to these Terms
            on your behalf.
          </Body>
          <Body>
            We do not knowingly collect personal information from children under 13. If we learn
            that we have collected such information, we will delete it promptly. If you believe a
            child under 13 has provided us with personal information, please contact us at{" "}
            {CONTACT_EMAIL}.
          </Body>
        </Section>

        {/* ── 3. Your Account ── */}
        <Section number="3" title="Your Account">
          <Body>
            You may create an account using Google OAuth or a verified email address (passwordless
            one-time code). You are responsible for maintaining the security of your account and
            for all activity that occurs under it. You agree to:
          </Body>
          <Bullet>Provide accurate and complete information</Bullet>
          <Bullet>Keep your account information current</Bullet>
          <Bullet>Not share your account with others or create accounts on behalf of others without their consent</Bullet>
          <Bullet>Notify us immediately of any unauthorized use of your account</Bullet>
          <Body>
            We reserve the right to suspend or terminate accounts that violate these Terms, at our
            sole discretion and without prior notice.
          </Body>
        </Section>

        {/* ── 4. User Content ── */}
        <Section number="4" title="User Content">
          <Body>
            "User Content" means all data you enter or upload through the Service, including golf
            scores, statistics, course information, round details, profile information, and profile
            photos.
          </Body>
          <Body>
            You retain ownership of your User Content. By using the Service, you grant Trent
            Dahlheimer a non-exclusive, worldwide, royalty-free license to store, process, display,
            and transmit your User Content solely to provide and improve the Service.
          </Body>
          <Body>
            You are solely responsible for the accuracy of your User Content. You agree not to
            enter false, defamatory, or misleading content. We may remove User Content that
            violates these Terms, without notice.
          </Body>
        </Section>

        {/* ── 5. Acceptable Use ── */}
        <Section number="5" title="Acceptable Use">
          <Body>You agree not to:</Body>
          <Bullet>Use the Service for any unlawful purpose or in violation of any applicable law</Bullet>
          <Bullet>Attempt to gain unauthorized access to any part of the Service or its systems</Bullet>
          <Bullet>Interfere with or disrupt the integrity or performance of the Service</Bullet>
          <Bullet>Collect personally identifiable information from other users without their consent</Bullet>
          <Bullet>Impersonate any person or entity</Bullet>
          <Bullet>Upload or transmit viruses or other malicious code</Bullet>
          <Bullet>Use the Service to send unsolicited commercial communications (spam)</Bullet>
          <Bullet>Engage in any conduct that restricts or inhibits others' use or enjoyment of the Service</Bullet>
        </Section>

        {/* ── 6. Third-Party Services ── */}
        <Section number="6" title="Third-Party Services">
          <Body>
            The Service integrates with the following third-party providers. Your use of those
            services is subject to their respective privacy policies and terms:
          </Body>
          <Bullet>Supabase — authentication, database storage, and file storage (supabase.com/privacy)</Bullet>
          <Bullet>Google — OAuth single sign-on (policies.google.com/privacy)</Bullet>
          <Bullet>Grafana Cloud — service monitoring and telemetry (grafana.com/legal/privacy-policy)</Bullet>
          <Bullet>Railway — cloud hosting infrastructure (railway.app/legal/privacy)</Bullet>
          <Bullet>GolfCourseAPI.com — golf course data for imported courses</Bullet>
          <Body>
            We are not responsible for the privacy practices or content of these third-party
            services.
          </Body>
        </Section>

        {/* ── 7. Golf Data and Handicaps ── */}
        <Section number="7" title="Golf Data and Handicaps">
          <Body>
            The Service allows you to record golf scores, statistics, and related data for personal
            tracking, league management, and tournament purposes.
          </Body>
          <Body>
            The Service does not calculate or issue official World Handicap System (WHS) handicap
            indexes. Course handicap values entered in the App are user-entered estimates for league
            and tournament purposes only and carry no official standing with the USGA, R&A, or any
            golf governing body.
          </Body>
          <Body>
            We make no warranty as to the accuracy or completeness of golf course data, including
            par, slope ratings, course ratings, yardages, or hole-by-hole handicap assignments.
          </Body>
        </Section>

        {/* ── 8. Intellectual Property ── */}
        <Section number="8" title="Intellectual Property">
          <Body>
            The Service and all content created by us — including the design, code, graphics, and
            branding — are owned by Trent Dahlheimer and protected by applicable copyright,
            trademark, and other intellectual property laws. You may not copy, modify, distribute,
            sell, or create derivative works of the Service or its content without prior written
            permission. "Golf Stuff In Here" and related marks are the property of Trent
            Dahlheimer.
          </Body>
        </Section>

        {/* ── 9. Privacy ── */}
        <Section number="9" title="Privacy">
          <Body>
            Your use of the Service is also governed by our Privacy Policy, which is incorporated
            into these Terms by reference. By using the Service, you consent to the data practices
            described in our Privacy Policy. Please review our Privacy Policy to understand our
            practices.
          </Body>
        </Section>

        {/* ── 10. Disclaimers ── */}
        <Section number="10" title="Disclaimers">
          <Caps>
            THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND,
            EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS
            FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE
            WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF VIRUSES OR OTHER HARMFUL
            COMPONENTS. YOUR USE OF THE SERVICE IS AT YOUR SOLE RISK.
          </Caps>
        </Section>

        {/* ── 11. Limitation of Liability ── */}
        <Section number="11" title="Limitation of Liability">
          <Caps>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, TRENT DAHLHEIMER SHALL NOT BE
            LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE
            DAMAGES, INCLUDING WITHOUT LIMITATION LOSS OF PROFITS, LOSS OF DATA, LOSS OF GOODWILL,
            SERVICE INTERRUPTION, OR THE COST OF SUBSTITUTE SERVICES, ARISING OUT OF OR IN
            CONNECTION WITH THESE TERMS OR YOUR USE OF OR INABILITY TO USE THE SERVICE, EVEN IF
            ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
          </Caps>
          <Caps>
            OUR TOTAL LIABILITY TO YOU FOR ANY CLAIMS ARISING FROM OR RELATING TO THESE TERMS OR
            THE SERVICE SHALL NOT EXCEED ONE HUNDRED DOLLARS ($100.00 USD).
          </Caps>
          <Body>
            Some jurisdictions do not allow the exclusion or limitation of liability for
            consequential or incidental damages, so the above limitation may not apply to you.
          </Body>
        </Section>

        {/* ── 12. Indemnification ── */}
        <Section number="12" title="Indemnification">
          <Body>
            You agree to indemnify, defend, and hold harmless Trent Dahlheimer and his heirs,
            successors, and assigns from and against any and all claims, liabilities, damages,
            losses, costs, and expenses (including reasonable attorneys' fees) arising from: (a)
            your use of the Service; (b) your violation of these Terms; (c) your violation of any
            applicable law; or (d) your infringement of any rights of a third party.
          </Body>
        </Section>

        {/* ── 13. Termination ── */}
        <Section number="13" title="Termination">
          <Body>
            We may suspend or terminate your access to the Service at any time, with or without
            cause, and without liability to you. You may terminate your account at any time by
            contacting us at {CONTACT_EMAIL}. Note that due to database retention and backup
            practices, some data may be retained for a period after account deletion.
          </Body>
          <Body>
            Sections 4, 8, 10, 11, 12, and 14 of these Terms survive termination.
          </Body>
        </Section>

        {/* ── 14. Governing Law ── */}
        <Section number="14" title="Governing Law and Dispute Resolution">
          <Body>
            These Terms are governed by and construed in accordance with the laws of the State of
            Missouri, without regard to its conflict of law principles. Any legal action or
            proceeding arising from or relating to these Terms or the Service shall be brought
            exclusively in the state or federal courts located in Missouri. You hereby consent to
            the exclusive jurisdiction and venue of such courts.
          </Body>
        </Section>

        {/* ── 15. Changes to Terms ── */}
        <Section number="15" title="Changes to These Terms">
          <Body>
            We may modify these Terms at any time. We will notify you of material changes by
            updating the "Last Updated" date at the top of this page and, where appropriate, by
            providing notice through the Service. Your continued use of the Service after any
            changes constitutes your acceptance of the updated Terms. If you do not agree to the
            updated Terms, you must stop using the Service.
          </Body>
        </Section>

        {/* ── 16. Severability and Waiver ── */}
        <Section number="16" title="Severability and Waiver">
          <Body>
            If any provision of these Terms is found to be unenforceable or invalid, that provision
            will be limited or eliminated to the minimum extent necessary so that these Terms
            otherwise remain in full force and effect. Our failure to enforce any right or provision
            of these Terms will not be deemed a waiver of such right or provision.
          </Body>
        </Section>

        {/* ── 17. Entire Agreement ── */}
        <Section number="17" title="Entire Agreement">
          <Body>
            These Terms, together with our Privacy Policy, constitute the entire agreement between
            you and Trent Dahlheimer regarding your use of the Service and supersede all prior
            agreements, proposals, or representations, written or oral, concerning the Service.
          </Body>
        </Section>

        {/* ── 18. Contact ── */}
        <Section number="18" title="Contact Us">
          <Body>
            If you have any questions about these Terms, please contact us:
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
