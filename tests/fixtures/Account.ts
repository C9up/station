/**
 * Entity with the columns an admin must never leak or let through by
 * accident: a `serializeAs: null` password hash, a name-matched API token and
 * a privilege flag. Used by the column-exposure / mass-assignment suites.
 */
import "reflect-metadata";
import { BaseEntity, Column, Entity, PrimaryKey } from "@c9up/atlas";

@Entity("accounts")
export class Account extends BaseEntity {
	@PrimaryKey() declare id: number;
	@Column() declare email: string;
	@Column({ serializeAs: null }) declare password: string;
	@Column({ nullable: true }) declare apiToken: string | null;
	@Column({ type: "boolean" }) declare isAdmin: boolean;
}
