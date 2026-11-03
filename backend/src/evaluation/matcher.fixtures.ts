// T781 STEP 2 equivalence fixture: captured from the PRE-MOVE
// `backend/src/routes/job-match.ts` implementation of `matchResumeToJob`
// via `backend/scripts/capture-matcher-fixture.ts` (throwaway, since removed).
// The equivalence test asserts the extracted module reproduces these outputs
// byte-identically. DO NOT hand-edit: regenerate from the pre-move code.
import type { MatchResult, ResumeData } from './matcher.js';

export interface MatcherFixture {
  name: string;
  resume: ResumeData;
  jobDescription: string;
  expected: MatchResult;
}

export const MATCHER_FIXTURES: MatcherFixture[] = [
  {
    "name": "strong-frontend-match",
    "resume": {
      "personalInfo": {
        "fullName": "Ada Lovelace",
        "email": "ada@example.com",
        "phone": "555-0100",
        "location": "Berlin"
      },
      "summary": "Senior frontend engineer with 6 years of React and TypeScript experience.",
      "experience": [
        {
          "title": "Senior Frontend Engineer",
          "company": "Acme",
          "bullets": [
            "Built React apps with TypeScript",
            "GraphQL APIs with Node.js and Docker deployments"
          ]
        }
      ],
      "education": [
        {
          "degree": "BSc",
          "field": "Computer Science",
          "institution": "TU Berlin"
        }
      ],
      "skills": [
        "React",
        "TypeScript",
        "GraphQL",
        "Node.js"
      ]
    },
    "jobDescription": "Senior Frontend Engineer\nWe are looking for a Senior Frontend Engineer with strong React and TypeScript skills.\nYou will build GraphQL APIs backed by Node.js, ship with Docker and Kubernetes,\nand work with PostgreSQL. Familiarity with machine learning is a plus.",
    "expected": {
      "matchScore": 58,
      "matchedKeywords": [
        "javascript",
        "typescript",
        "graphql",
        "docker",
        "react",
        "api",
        "r"
      ],
      "missingKeywords": [
        "machine learning",
        "kubernetes",
        "postgresql",
        "node.js",
        "sql"
      ],
      "suggestions": [
        "Moderate match. Tailor your resume to better fit this role before applying.",
        "Critical missing skills: javascript"
      ],
      "detectedRole": "frontend-engineer",
      "criticalMissing": [
        "javascript"
      ],
      "preferredMissing": [],
      "roleSuggestions": []
    }
  },
  {
    "name": "weak-cross-domain",
    "resume": {
      "personalInfo": {
        "fullName": "Ada Lovelace",
        "email": "ada@example.com",
        "phone": "555-0100",
        "location": "Berlin"
      },
      "summary": "Frontend developer focused on CSS and responsive design.",
      "experience": [
        {
          "title": "Frontend Developer",
          "company": "ShopCo",
          "bullets": [
            "Responsive design with CSS and accessibility improvements"
          ]
        }
      ],
      "education": [],
      "skills": [
        "CSS",
        "HTML",
        "Figma"
      ]
    },
    "jobDescription": "Data Scientist\nSeeking a Data Scientist with Python, machine learning, pandas, SQL and statistics.\nExperience with experimentation and A/B testing required. Spark is a plus.",
    "expected": {
      "matchScore": 10,
      "matchedKeywords": [
        "r"
      ],
      "missingKeywords": [
        "machine learning",
        "experimentation",
        "a/b testing",
        "statistics",
        "testing",
        "python",
        "pandas",
        "spark",
        "sql"
      ],
      "suggestions": [
        "This role likely needs significant resume customization to pass ATS screening.",
        "Critical missing skills: python, machine learning, sql, statistics, pandas",
        "Preferred (nice-to-have) skills to consider: spark, experimentation"
      ],
      "detectedRole": "data-scientist",
      "criticalMissing": [
        "python",
        "machine learning",
        "sql",
        "statistics",
        "pandas"
      ],
      "preferredMissing": [
        "spark",
        "experimentation"
      ],
      "roleSuggestions": []
    }
  },
  {
    "name": "empty-job-description",
    "resume": {
      "personalInfo": {
        "fullName": "Ada Lovelace",
        "email": "ada@example.com",
        "phone": "555-0100",
        "location": "Berlin"
      },
      "summary": "Backend engineer with Go and Kubernetes.",
      "experience": [],
      "education": [],
      "skills": [
        "Go",
        "Kubernetes"
      ]
    },
    "jobDescription": "",
    "expected": {
      "matchScore": 0,
      "matchedKeywords": [],
      "missingKeywords": [],
      "suggestions": [
        "This role likely needs significant resume customization to pass ATS screening."
      ],
      "detectedRole": null,
      "criticalMissing": [],
      "preferredMissing": [],
      "roleSuggestions": []
    }
  },
  {
    "name": "synonym-heavy",
    "resume": {
      "personalInfo": {
        "fullName": "Ada Lovelace",
        "email": "ada@example.com",
        "phone": "555-0100",
        "location": "Berlin"
      },
      "summary": "Platform engineer working with k8s clusters and ml pipelines on postgres.",
      "experience": [
        {
          "title": "Platform Engineer",
          "company": "InfraCo",
          "bullets": [
            "Operated k8s clusters",
            "Built ml feature pipelines over postgres"
          ]
        }
      ],
      "education": [],
      "skills": [
        "k8s",
        "ml",
        "postgres",
        "Terraform"
      ]
    },
    "jobDescription": "Platform Engineer\nWe need Kubernetes experience, machine learning fundamentals, PostgreSQL,\nTerraform and AWS for our platform team.",
    "expected": {
      "matchScore": 57,
      "matchedKeywords": [
        "machine learning",
        "kubernetes",
        "postgresql",
        "r"
      ],
      "missingKeywords": [
        "terraform",
        "sql",
        "aws"
      ],
      "suggestions": [
        "Moderate match. Tailor your resume to better fit this role before applying.",
        "Critical missing skills: aws"
      ],
      "detectedRole": "devops-engineer",
      "criticalMissing": [
        "aws"
      ],
      "preferredMissing": [],
      "roleSuggestions": []
    }
  },
  {
    "name": "empty-resume",
    "resume": {
      "personalInfo": {
        "fullName": "Ada Lovelace",
        "email": "ada@example.com",
        "phone": "555-0100",
        "location": "Berlin"
      },
      "summary": "",
      "experience": [],
      "education": [],
      "skills": []
    },
    "jobDescription": "Frontend Engineer\nLooking for React, TypeScript and Node.js developers with Jest testing experience.",
    "expected": {
      "matchScore": 0,
      "matchedKeywords": [],
      "missingKeywords": [
        "javascript",
        "typescript",
        "node.js",
        "testing",
        "react",
        "jest",
        "r"
      ],
      "suggestions": [
        "This role likely needs significant resume customization to pass ATS screening.",
        "Critical missing skills: javascript, typescript, react, testing",
        "Preferred (nice-to-have) skills to consider: jest"
      ],
      "detectedRole": "frontend-engineer",
      "criticalMissing": [
        "javascript",
        "typescript",
        "react",
        "testing"
      ],
      "preferredMissing": [
        "jest"
      ],
      "roleSuggestions": []
    }
  }
];
