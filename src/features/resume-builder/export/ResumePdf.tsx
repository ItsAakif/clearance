import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import { pdf } from '@react-pdf/renderer';
import { ResumeData } from '@/types/resume';

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica', color: '#111' },
  name: { fontSize: 20, fontFamily: 'Helvetica-Bold', textAlign: 'center', marginBottom: 2 },
  contact: { fontSize: 9, textAlign: 'center', color: '#555', marginBottom: 14 },
  sectionTitle: { fontSize: 12, fontFamily: 'Helvetica-Bold', borderBottom: '1pt solid #222', paddingBottom: 2, marginBottom: 6 },
  entry: { marginBottom: 8 },
  entryHeader: { fontFamily: 'Helvetica-Bold', fontSize: 10 },
  entrySub: { fontSize: 9, color: '#333' },
  bullet: { fontSize: 9, marginLeft: 10, marginBottom: 1 },
  muted: { fontSize: 9, color: '#555' },
});

// In-browser PDF rendering of a resume (reconciles with the server Playwright
// export already used elsewhere). No server round-trip.
export function ResumePdfDocument({ data }: { data: ResumeData }) {
  const { personalInfo, summary, experience, education, skills, projects, languages } = data;
  return (
    <Document>
      <Page size="Letter" style={styles.page}>
        <Text style={styles.name}>{personalInfo.fullName || 'Your Name'}</Text>
        <Text style={styles.contact}>
          {[personalInfo.email, personalInfo.phone, personalInfo.location, personalInfo.linkedin, personalInfo.website]
            .filter(Boolean)
            .join('   |   ')}
        </Text>

        {summary ? (
          <View style={{ marginBottom: 10 }}>
            <Text style={styles.sectionTitle}>Summary</Text>
            <Text>{summary}</Text>
          </View>
        ) : null}

        {experience && experience.length > 0 ? (
          <View style={{ marginBottom: 10 }}>
            <Text style={styles.sectionTitle}>Experience</Text>
            {experience.map((e) => (
              <View key={e.id} style={styles.entry}>
                <Text style={styles.entryHeader}>
                  {e.title || ''}
                  {e.company ? `  —  ${e.company}` : ''}
                </Text>
                <Text style={styles.entrySub}>
                  {[e.startDate, e.endDate].filter(Boolean).join(' – ')}
                </Text>
                {(e.bullets || []).map((b, i) => (
                  <Text key={i} style={styles.bullet}>• {b}</Text>
                ))}
              </View>
            ))}
          </View>
        ) : null}

        {education && education.length > 0 ? (
          <View style={{ marginBottom: 10 }}>
            <Text style={styles.sectionTitle}>Education</Text>
            {education.map((e) => (
              <View key={e.id} style={styles.entry}>
                <Text style={styles.entryHeader}>{e.degree || ''}</Text>
                <Text style={styles.entrySub}>
                  {[e.institution, e.field, e.graduationYear].filter(Boolean).join(', ')}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {projects && projects.length > 0 ? (
          <View style={{ marginBottom: 10 }}>
            <Text style={styles.sectionTitle}>Projects</Text>
            {projects.map((p) => (
              <View key={p.id} style={styles.entry}>
                <Text style={styles.entryHeader}>{p.title || ''}</Text>
                {p.description ? <Text style={styles.muted}>{p.description}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}

        {skills && skills.length > 0 ? (
          <View style={{ marginBottom: 10 }}>
            <Text style={styles.sectionTitle}>Skills</Text>
            <Text>{skills.join(', ')}</Text>
          </View>
        ) : null}

        {languages && languages.length > 0 ? (
          <View>
            <Text style={styles.sectionTitle}>Languages</Text>
            <Text>{languages.join(', ')}</Text>
          </View>
        ) : null}
      </Page>
    </Document>
  );
}

export async function exportResumePdf(data: ResumeData, filename: string): Promise<void> {
  const blob = await pdf(<ResumePdfDocument data={data} />).toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
