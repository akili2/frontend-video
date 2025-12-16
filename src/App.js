import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import io from 'socket.io-client';

// Remplacez par l'URL de votre backend Render
const SOCKET_SERVER_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:5000';

function App() {
  const [socket, setSocket] = useState(null);
  const [callCode, setCallCode] = useState('');
  const [inputCallCode, setInputCallCode] = useState('');
  const [callStatus, setCallStatus] = useState('idle'); // idle, creating, waiting, joined, in-call
  const [participants, setParticipants] = useState(0);
  const [error, setError] = useState('');

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnection = useRef(null);
  const localStream = useRef(null);
  const socketRef = useRef(null);

  // Configuration STUN/TURN (utilisez un service comme Twilio ou Xirsys pour la production)
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  useEffect(() => {
    // Initialiser la connexion Socket.io
    const newSocket = io(SOCKET_SERVER_URL);
    socketRef.current = newSocket;
    setSocket(newSocket);

    // Écouter les événements du serveur
    newSocket.on('call-created', handleCallCreated);
    newSocket.on('call-joined', handleCallJoined);
    newSocket.on('call-not-found', handleCallNotFound);
    newSocket.on('call-full', handleCallFull);
    newSocket.on('participant-joined', handleParticipantJoined);
    newSocket.on('participant-left', handleParticipantLeft);
    newSocket.on('receive-offer', handleReceiveOffer);
    newSocket.on('receive-answer', handleReceiveAnswer);
    newSocket.on('receive-ice-candidate', handleReceiveIceCandidate);

    // Demander l'accès à la caméra/microphone
    initMediaDevices();

    return () => {
      newSocket.disconnect();
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const initMediaDevices = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      localStream.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error('Erreur d\'accès aux médias:', err);
      setError('Impossible d\'accéder à la caméra/microphone');
    }
  };

  const createPeerConnection = () => {
    const pc = new RTCPeerConnection(configuration);
    
    // Ajouter le flux local
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        pc.addTrack(track, localStream.current);
      });
    }

    // Gérer les candidats ICE
    pc.onicecandidate = (event) => {
      if (event.candidate && callCode) {
        socketRef.current.emit('send-ice-candidate', {
          callCode,
          candidate: event.candidate
        });
      }
    };

    // Gérer le flux distant
    pc.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    peerConnection.current = pc;
    return pc;
  };

  const handleCallCreated = (data) => {
    setCallCode(data.callCode);
    setCallStatus('waiting');
    setError('');
  };

  const handleCallJoined = (data) => {
    setCallStatus('joined');
    setCallCode(inputCallCode);
    setError('');
  };

  const handleCallNotFound = () => {
    setError('Code d\'appel introuvable');
    setCallStatus('idle');
  };

  const handleCallFull = () => {
    setError('L\'appel est complet (maximum 2 participants)');
    setCallStatus('idle');
  };

  const handleParticipantJoined = (data) => {
    setParticipants(2);
    setCallStatus('in-call');
    // Créer l'offre WebRTC
    createAndSendOffer();
  };

  const handleParticipantLeft = () => {
    setParticipants(1);
    setCallStatus('waiting');
    setError('Le participant a quitté l\'appel');
  };

  const handleReceiveOffer = async (data) => {
    setCallStatus('in-call');
    setParticipants(2);
    
    const pc = createPeerConnection();
    
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socketRef.current.emit('send-answer', {
      callCode,
      answer
    });
  };

  const handleReceiveAnswer = async (data) => {
    if (peerConnection.current) {
      await peerConnection.current.setRemoteDescription(
        new RTCSessionDescription(data.answer)
      );
    }
  };

  const handleReceiveIceCandidate = async (data) => {
    if (peerConnection.current && data.candidate) {
      try {
        await peerConnection.current.addIceCandidate(
          new RTCIceCandidate(data.candidate)
        );
      } catch (err) {
        console.error('Erreur d\'ajout du candidat ICE:', err);
      }
    }
  };

  const createAndSendOffer = async () => {
    const pc = createPeerConnection();
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    socketRef.current.emit('send-offer', {
      callCode,
      offer
    });
  };

  const createCall = () => {
    if (socketRef.current) {
      setCallStatus('creating');
      socketRef.current.emit('create-call');
    }
  };

  const joinCall = () => {
    if (inputCallCode.trim().length === 6) {
      setCallStatus('joining');
      socketRef.current.emit('join-call', { callCode: inputCallCode.toUpperCase() });
    } else {
      setError('Le code doit contenir 6 caractères');
    }
  };

  const endCall = () => {
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
    }
    setCallStatus('idle');
    setCallCode('');
    setInputCallCode('');
    setParticipants(0);
    setError('');
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>🚀 Appel Vidéo Simple</h1>
        <p>Créez ou rejoignez un appel avec un code secret</p>
      </header>

      <main className="App-main">
        {error && <div className="error-message">{error}</div>}

        {callStatus === 'idle' && (
          <div className="call-actions">
            <button className="btn-create" onClick={createCall}>
              Créer un nouvel appel
            </button>
            
            <div className="join-section">
              <h3>Rejoindre un appel</h3>
              <input
                type="text"
                placeholder="Entrez le code (6 caractères)"
                value={inputCallCode}
                onChange={(e) => setInputCallCode(e.target.value.toUpperCase())}
                maxLength="6"
              />
              <button className="btn-join" onClick={joinCall}>
                Rejoindre
              </button>
            </div>
          </div>
        )}

        {callStatus === 'creating' && (
          <div className="loading">
            <p>Création de l'appel en cours...</p>
          </div>
        )}

        {callStatus === 'waiting' && (
          <div className="waiting-room">
            <h2>⏳ En attente d'un participant...</h2>
            <div className="call-code-display">
              <p>Code d'appel :</p>
              <h1>{callCode}</h1>
              <p>Partagez ce code avec la personne que vous voulez appeler</p>
            </div>
            <button className="btn-end" onClick={endCall}>
              Annuler l'appel
            </button>
          </div>
        )}

        {(callStatus === 'joined' || callStatus === 'in-call') && (
          <div className="video-container">
            <div className="video-grid">
              <div className="video-wrapper">
                <h3>Vous</h3>
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="video-element"
                />
              </div>
              
              <div className="video-wrapper">
                <h3>Participant</h3>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="video-element"
                />
                {!remoteVideoRef.current?.srcObject && (
                  <div className="waiting-video">
                    <p>En attente de la vidéo du participant...</p>
                  </div>
                )}
              </div>
            </div>
            
            <div className="call-info">
              <p>Code d'appel : <strong>{callCode}</strong></p>
              <p>Participants : <strong>{participants}/2</strong></p>
            </div>
            
            <button className="btn-end" onClick={endCall}>
              Terminer l'appel
            </button>
          </div>
        )}
      </main>

      <footer className="App-footer">
        <p>Application d'appel vidéo • Hébergé sur Render + Vercel</p>
      </footer>
    </div>
  );
}

export default App;