import { shirtIndex, type TOfficeRole } from './officeModel';
import styles from './Office.module.css';

const SHIRT_CLASSES = [styles.shirt0, styles.shirt1, styles.shirt2, styles.shirt3, styles.shirt4, styles.shirt5];

/** Класс, задающий `--office-shirt` роли: человечек за столом и в комнате отдыха одного цвета. */
export const shirtClassOf = (role: TOfficeRole): string | undefined => SHIRT_CLASSES[shirtIndex(role)];
