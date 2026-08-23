"use client";

import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { RoundedBox, Float, Text } from "@react-three/drei";
import * as THREE from "three";
function Document() {
  const groupRef = useRef<THREE.Group>(null);
  useFrame(state => {
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.3) * 0.1;
    }
  });
  return <Float speed={2} rotationIntensity={0.2} floatIntensity={0.5}>
      <group ref={groupRef}>
        {/* Main document */}
        <RoundedBox args={[2.5, 3.2, 0.08]} radius={0.08} smoothness={4}>
          <meshStandardMaterial color="#ffffff" metalness={0.1} roughness={0.2} />
        </RoundedBox>

        {/* Document lines - simulating text */}
        {[0.9, 0.5, 0.1, -0.3, -0.7].map((y, i) => <mesh key={i} position={[0, y, 0.05]}>
            <boxGeometry args={[i === 0 ? 1.5 : 2, 0.08, 0.01]} />
            <meshStandardMaterial color={i === 0 ? "#22a195" : "#e0e0e0"} metalness={0.1} />
          </mesh>)}

        {/* Floating accent shapes */}
        <mesh position={[1.8, 1.8, 0.2]} scale={0.3}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshStandardMaterial color="#fcd34d" metalness={0.3} roughness={0.2} transparent opacity={0.9} />
        </mesh>

        <mesh position={[-1.6, -1.5, 0.3]} scale={0.25}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshStandardMaterial color="#86efac" metalness={0.3} roughness={0.2} transparent opacity={0.9} />
        </mesh>

        <mesh position={[1.5, -1.8, 0.15]} scale={0.2}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshStandardMaterial color="#fda4af" metalness={0.3} roughness={0.2} transparent opacity={0.9} />
        </mesh>
      </group>
    </Float>;
}
interface FloatingDocumentProps {
  className?: string;
}
export default function FloatingDocument({
  className
}: FloatingDocumentProps) {
  return (
    <Canvas camera={{ position: [0, 0, 6], fov: 50 }} className={className}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 5, 5]} intensity={0.8} />
      <Document />
    </Canvas>
  );
}