// Site rules for the "Back Exit" camera. The AI agent retrieves the most relevant ones for each incident.
// These are the DEMO's rules: edit the text, add or remove items. Keep each rule short and self-contained.
module.exports = [
  { id: 'R1', title: 'Restricted hours', text: 'The back exit door is closed to everyone from 22:00 to 06:00. Any person here at night is unusual. A weapon seen during restricted hours is high risk (8 to 10).' },
  { id: 'R2', title: 'Authorized staff', text: 'The night security guard and the cleaning crew, wearing badges or uniform, may be at the back exit at night. A uniformed guard with a holstered radio, baton or flashlight is Safe.' },
  { id: 'R3', title: 'Daytime deliveries', text: 'During the day, delivery staff use the back exit. Boxes, box cutters and work tools being carried or used normally are Safe (risk 1 to 3) unless raised or pointed at someone.' },
  { id: 'R4', title: 'Kitchen and cleaning items', text: 'Kitchen knives, scissors, spray bottles and cleaning tools carried to work, in a bag or held down are Safe. They become an Alert only when raised, pointed or brandished.' },
  { id: 'R5', title: 'Toys, props and screens', text: 'Toy guns, water pistols, costume props, posters and a weapon picture shown on a phone or screen are Safe. Say it looks like a toy or a screen. If you cannot tell, treat it as real.' },
  { id: 'R6', title: 'Weapon aimed or brandished', text: 'A gun or knife held up, aimed at someone or swung is an Alert with risk 9 to 10 at any time of day.' },
  { id: 'R7', title: 'Weapon carried but not aimed', text: 'A real-looking gun or knife that is holstered, tucked in a belt or held down is an Alert with risk 6 to 8, and 8 or more at night.' },
  { id: 'R8', title: 'Grenade or explosive', text: 'A grenade or explosive-looking object is always an Alert with risk 9 to 10. Advise people to stay away and never approach it.' },
  { id: 'R9', title: 'Groups and loitering', text: 'Two or more people at the door at night, or someone loitering for more than a minute, raises the risk by 1 or 2 points.' },
  { id: 'R10', title: 'Face covered', text: 'A mask, hood or scarf hiding the face together with a weapon raises the risk by 1 point.' },
  { id: 'R11', title: 'Escalation steps', text: 'Risk 6 or more: sound the buzzer and notify the security team. Risk 9 or 10: advise calling the emergency services. Staff must never confront the person.' },
  { id: 'R12', title: 'Unclear image', text: 'If the image is blurry, dark or hard to read, say so in the summary and lean toward Alert, but cap the risk at 6 and mark it for human review.' },
];
