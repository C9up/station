/**
 * Minimal Atlas entity used by the list-show roundtrip integration test.
 * Lives under `tests/fixtures/` because it has no place in published src/
 * — Station has no opinion on entity shape; it just lifts metadata via
 * `@c9up/atlas`'s decorators at route-mount time.
 */
import "reflect-metadata";
import { BaseEntity, Column, Entity, PrimaryKey } from "@c9up/atlas";

@Entity("users")
export class User extends BaseEntity {
	@PrimaryKey() declare id: number;
	@Column() declare name: string;
	@Column({ type: "integer" }) declare age: number;
}
